import PostalMime from 'postal-mime';
import { Env, TokenPayload, ResendAttachment } from './types';
import { createEncryptedToken, decryptToken } from './crypto';
import { isAllowedGmailSender, verifyEmailAuthentication, extractEmailAddress } from './security';
import { sendEmailViaResend } from './resend';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';

/**
 * 文字列、ArrayBuffer、Uint8Array を Base64 文字列に安全に変換
 */
export function contentToBase64(content: string | ArrayBuffer | Uint8Array): string {
  if (typeof content === 'string') {
    return btoa(unescape(encodeURIComponent(content)));
  }
  let binary = '';
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  const chunkSize = 0x8000; // 32KB ごとにチャンク処理（スタックオーバーフロー防止）
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

/**
 * メールアドレスからドメイン部分を抽出
 */
export function extractDomain(email: string): string {
  const cleanEmail = extractEmailAddress(email);
  const atIndex = cleanEmail.lastIndexOf('@');
  if (atIndex === -1) return '';
  return cleanEmail.slice(atIndex + 1);
}

/**
 * Inbound Relay: 独自ドメイン宛のメールを受信し、Reply-To を書き換えて個人Gmailへ転送
 */
async function handleInboundRelay(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBuffer);

  const originalFrom = extractEmailAddress(message.from);
  const originalTo = extractEmailAddress(message.to);
  const targetDomain = extractDomain(message.to);

  if (!targetDomain) {
    throw new Error(`Unable to determine target domain from message.to: ${message.to}`);
  }

  // 1. 暗号化トークンの生成
  const payload: TokenPayload = {
    originalFrom: originalFrom,
    targetDomain: targetDomain,
    originalTo: originalTo,
    timestamp: Date.now(),
  };

  const token = await createEncryptedToken(payload, env.SECRET_KEY);
  const proxyReplyToAddress = `reply+${token}@${targetDomain}`;

  // 2. ヘッダーの書き換え (Reply-To をプロキシアドレスに設定)
  const modifiedHeaders = new Headers();
  modifiedHeaders.set('Reply-To', proxyReplyToAddress);

  // 3. 個人Gmailへ転送
  await message.forward(env.ALLOWED_GMAIL_ADDRESS, modifiedHeaders);
}

/**
 * Outbound Re-send: 個人Gmailからの返信メールを受信し、トークンを復号してResend経由で相手へ送信
 */
async function handleOutboundResend(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  // 1. セキュリティ検証（必須）
  const authResult = verifyEmailAuthentication(message.headers);
  if (!authResult.passed) {
    const rejectReason = `SPF/DKIM verification failed: ${authResult.reason || 'Not authenticated'}`;
    message.setReject(rejectReason);
    throw new Error(rejectReason);
  }

  // 2. 宛先トークンの抽出
  const toAddress = extractEmailAddress(message.to);
  const tokenMatch = toAddress.match(/^reply\+([a-zA-Z0-9_-]+)@([a-zA-Z0-9.-]+)$/i);

  if (!tokenMatch) {
    const errorMsg = `Invalid proxy recipient format: "${toAddress}". Expected reply+{token}@{domain}`;
    message.setReject(errorMsg);
    throw new Error(errorMsg);
  }

  const token = tokenMatch[1];
  const domainFromTo = tokenMatch[2].toLowerCase();

  // 3. トークンの復号 & 有効期限検証
  const expirationDays = env.TOKEN_EXPIRATION_DAYS
    ? parseInt(env.TOKEN_EXPIRATION_DAYS, 10)
    : 30;

  let payload: TokenPayload;
  try {
    payload = await decryptToken(token, env.SECRET_KEY, expirationDays);
  } catch (decryptErr: any) {
    const errMessage = decryptErr?.message || 'Token decryption failed';

    // 復号失敗時は個人Gmailへエラー通知を返送
    try {
      await sendEmailViaResend(
        {
          from: `PrismPost Notification <info@${domainFromTo}>`,
          to: env.ALLOWED_GMAIL_ADDRESS,
          subject: '【PrismPost】メール送信エラー: 返信トークンが無効または期限切れです',
          text: `お送りいただいた返信メールの処理に失敗しました。\n\n理由: ${errMessage}\n宛先: ${message.to}\n\nトークンの有効期限切れ、または不正な宛先アドレスの可能性があります。`,
        },
        env.RESEND_API_KEY
      );
    } catch (notifyErr) {
      console.error('Failed to send error notification via Resend:', notifyErr);
    }

    message.setReject(`Decryption failed: ${errMessage}`);
    throw new Error(`Decryption failed: ${errMessage}`);
  }

  // 4. Rawメールのパース（本文、添付ファイル、スレッドヘッダー）
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBuffer);

  // スレッド整合性の維持 (In-Reply-To, References)
  const relayHeaders: Record<string, string> = {};
  const inReplyTo = message.headers.get('in-reply-to');
  if (inReplyTo) {
    relayHeaders['In-Reply-To'] = inReplyTo;
  }
  const references = message.headers.get('references');
  if (references) {
    relayHeaders['References'] = references;
  }

  // 添付ファイルの抽出とBase64変換
  const attachments: ResendAttachment[] = [];
  if (parsed.attachments && parsed.attachments.length > 0) {
    for (const att of parsed.attachments) {
      const base64Content = contentToBase64(att.content);
      attachments.push({
        filename: att.filename || 'attachment',
        content: base64Content,
        content_type: att.mimeType,
      });
    }
  }

  // 送信元情報の設定
  const senderName = env.DEFAULT_SENDER_NAME || 'Info';
  // 送信元メールアドレス: 本来受信した独自ドメインのアドレス（例: info@yourdomain.com）、無ければ info@{targetDomain}
  const senderEmailAddress = payload.originalTo || `info@${payload.targetDomain}`;
  const senderFrom = `${senderName} <${senderEmailAddress}>`;

  // 5. Resend API 経由で本来の宛先へ送信
  await sendEmailViaResend(
    {
      from: senderFrom,
      to: payload.originalFrom,
      subject: parsed.subject || '(No Subject)',
      text: parsed.text,
      html: parsed.html,
      headers: Object.keys(relayHeaders).length > 0 ? relayHeaders : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    },
    env.RESEND_API_KEY
  );
}

export default {
  /**
   * Cloudflare Workers Email Routing イベントハンドラ
   */
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const isFromGmail = isAllowedGmailSender(message.from, env.ALLOWED_GMAIL_ADDRESS);

    if (isFromGmail) {
      // 返信・正規再送フロー (Outbound Re-send)
      await handleOutboundResend(message, env);
    } else {
      // メール受信・転送フロー (Inbound Relay)
      await handleInboundRelay(message, env);
    }
  },
};
