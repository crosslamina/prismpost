import PostalMime from 'postal-mime';
import { Env, TokenPayload, ResendAttachment } from './types';
import {
  decryptToken,
  createReadableProxyAddress,
  parseReadableProxyAddress,
} from './crypto';
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
 * 正規表現の特殊文字をエスケープ
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 返信本文（テキスト/HTML）の引用中に含まれるプロキシアドレスを本来の独自ドメインアドレスに置換
 */
function sanitizeProxyAddressesInBody(
  body: string | undefined,
  proxyAddresses: string[],
  realSenderAddress: string
): string | undefined {
  if (!body) return body;
  let result = body;
  for (const proxyAddress of proxyAddresses) {
    const cleanProxy = extractEmailAddress(proxyAddress);
    if (!cleanProxy) continue;
    const pattern = new RegExp(escapeRegExp(cleanProxy), 'gi');
    result = result.replace(pattern, realSenderAddress);
  }
  return result;
}

/**
 * 単一のプロキシアドレス（可読形式 または 暗号化トークン形式）を解決する
 */
async function resolveProxyAddress(
  rawAddress: string,
  env: Env,
  notifyOnDecryptError: boolean = false
): Promise<TokenPayload> {
  const toAddress = extractEmailAddress(rawAddress);
  const readablePayload = parseReadableProxyAddress(toAddress);

  if (readablePayload) {
    return readablePayload;
  }

  // レガシー / 暗号化トークン形式 (reply+{token}@{domain}) の判定
  const tokenMatch = toAddress.match(/^reply\+([a-zA-Z0-9_-]+)@([a-zA-Z0-9.-]+)$/i);

  if (!tokenMatch) {
    throw new Error(
      `Invalid proxy recipient format: "${toAddress}". Expected {sender}+{user}={domain}@{targetDomain} or reply+{token}@{targetDomain}`
    );
  }

  const token = tokenMatch[1];
  const domainFromTo = tokenMatch[2].toLowerCase();

  const expirationDays = env.TOKEN_EXPIRATION_DAYS
    ? parseInt(env.TOKEN_EXPIRATION_DAYS, 10)
    : 30;

  try {
    return await decryptToken(token, env.SECRET_KEY, expirationDays);
  } catch (decryptErr: any) {
    const errMessage = decryptErr?.message || 'Token decryption failed';

    if (notifyOnDecryptError) {
      try {
        await sendEmailViaResend(
          {
            from: `PrismPost Notification <info@${domainFromTo}>`,
            to: env.ALLOWED_GMAIL_ADDRESS,
            subject: '【PrismPost】メール送信エラー: 返信トークンが無効または期限切れです',
            text: `お送りいただいた返信メールの処理に失敗しました。\n\n理由: ${errMessage}\n宛先: ${rawAddress}\n\nトークンの有効期限切れ、または不正な宛先アドレスの可能性があります。`,
          },
          env.RESEND_API_KEY
        );
      } catch (notifyErr) {
        console.error('Failed to send error notification via Resend:', notifyErr);
      }
    }

    throw new Error(`Decryption failed: ${errMessage}`);
  }
}

/**
 * Inbound Relay: 独自ドメイン宛のメールを受信し、Reply-To を書き換えて個人Gmailへ転送
 * Cloudflare の message.forward() を使用することで ARC 認証チェーンを維持し、
 * Gmail 本来の迷惑メールフィルタをそのまま機能させる
 */
async function handleInboundRelay(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBuffer);

  // エンベロープFrom (message.from) はバウンス先アドレス（SESやSendGrid等）になることがあるため、
  // メールヘッダーの Reply-To -> From -> エンベロープFrom の優先順位で返信先を決定する
  const replyToHeaderAddr = parsed.replyTo?.[0]?.address;
  const fromHeaderAddr = parsed.from?.address;
  const originalFrom = extractEmailAddress(replyToHeaderAddr || fromHeaderAddr || message.from);

  const originalTo = extractEmailAddress(message.to);
  const targetDomain = extractDomain(message.to);

  if (!targetDomain) {
    throw new Error(`Unable to determine target domain from message.to: ${message.to}`);
  }

  // 1. 可読プロキシアドレスを生成 (例: info+client=example.com@yourdomain.com)
  const proxyReplyToAddress = createReadableProxyAddress(originalFrom, targetDomain, originalTo);

  // 2. ヘッダーの書き換え (Reply-To をプロキシアドレスに設定)
  const modifiedHeaders = new Headers();
  modifiedHeaders.set('Reply-To', proxyReplyToAddress);

  // CC が存在する場合は変換済みプロキシアドレス一覧を X-PrismPost-Cc ヘッダーにも記録
  if (parsed.cc && parsed.cc.length > 0) {
    const ccProxies = parsed.cc
      .map((c) => c.address)
      .filter((addr): addr is string => Boolean(addr && addr.includes('@')))
      .map((addr) => createReadableProxyAddress(addr, targetDomain, originalTo));
    if (ccProxies.length > 0) {
      modifiedHeaders.set('X-PrismPost-Cc', ccProxies.join(', '));
    }
  }

  // 3. 個人Gmailへ転送
  await message.forward(env.ALLOWED_GMAIL_ADDRESS, modifiedHeaders);
}

/**
 * Outbound Re-send: 個人Gmailからの返信・新規メールを受信し、To / Cc の宛先を解決してResend経由で相手へ送信
 */
async function handleOutboundResend(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  // 1. セキュリティ検証（SPF/DKIM + 送信元ドメイン整合性チェック）
  const authResult = verifyEmailAuthentication(message.headers, env.ALLOWED_GMAIL_ADDRESS);
  if (!authResult.passed) {
    const rejectReason = `SPF/DKIM verification failed: ${authResult.reason || 'Not authenticated'}`;
    message.setReject(rejectReason);
    throw new Error(rejectReason);
  }

  // 2. エンベロープ宛先 (message.to) の解決・検証
  const envelopeTo = extractEmailAddress(message.to);
  let primaryPayload: TokenPayload;
  try {
    primaryPayload = await resolveProxyAddress(envelopeTo, env, true);
  } catch (err: any) {
    const errMsg = err?.message || 'Invalid recipient';
    message.setReject(errMsg);
    throw err;
  }

  // 3. Rawメールのパース（本文、添付ファイル、To/Ccヘッダー、スレッドヘッダー、ヘッダーFromの検証）
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBuffer);

  // MIMEヘッダー内の From が存在する場合も ALLOWED_GMAIL_ADDRESS と一致するか検証（ヘッダー偽装防止）
  if (parsed.from?.address && !isAllowedGmailSender(parsed.from.address, env.ALLOWED_GMAIL_ADDRESS)) {
    const rejectReason = `Header From "${parsed.from.address}" does not match allowed Gmail address`;
    message.setReject(rejectReason);
    throw new Error(rejectReason);
  }

  // 4. To / Cc の複数宛先解決 & 2重起動（重複送信）防止チェック
  const headerToAddresses = (parsed.to || [])
    .map((r) => (r.address ? extractEmailAddress(r.address) : ''))
    .filter(Boolean);
  const headerCcAddresses = (parsed.cc || [])
    .map((r) => (r.address ? extractEmailAddress(r.address) : ''))
    .filter(Boolean);

  const resolvedToList: string[] = [];
  const resolvedCcList: string[] = [];
  const allProxyAddressesInHeaders: string[] = [];

  for (const addr of headerToAddresses) {
    try {
      const p = await resolveProxyAddress(addr, env, false);
      resolvedToList.push(p.originalFrom);
      allProxyAddressesInHeaders.push(addr);
    } catch {
      // プロキシ形式でないアドレスはスキップ
    }
  }

  for (const addr of headerCcAddresses) {
    try {
      const p = await resolveProxyAddress(addr, env, false);
      resolvedCcList.push(p.originalFrom);
      allProxyAddressesInHeaders.push(addr);
    } catch {
      // プロキシ形式でないアドレスはスキップ
    }
  }

  // Gmailから同一ドメインの複数プロキシアドレス（To + Cc等）に送信した場合、
  // Cloudflare Email Routing は各プロキシアドレスごとに Worker を起動する。
  // 先頭（主宛先）の起動時のみ Resend API で To + Cc 一括送信を行い、2番目以降の起動はスキップする。
  if (allProxyAddressesInHeaders.length > 1) {
    const firstProxy = allProxyAddressesInHeaders[0].toLowerCase();
    const isCurrentInList = allProxyAddressesInHeaders.some(
      (a) => a.toLowerCase() === envelopeTo.toLowerCase()
    );
    if (isCurrentInList && envelopeTo.toLowerCase() !== firstProxy) {
      return;
    }
  }

  const finalToList = resolvedToList.length > 0 ? resolvedToList : [primaryPayload.originalFrom];
  const allProxyAddressesToSanitize = Array.from(
    new Set([envelopeTo, ...allProxyAddressesInHeaders])
  );

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
  const senderEmailAddress = primaryPayload.originalTo || `info@${primaryPayload.targetDomain}`;
  const senderFrom = `${senderName} <${senderEmailAddress}>`;

  // Gmail の引用文中に残ったすべてのプロキシアドレスを本来のアドレスに置換
  const cleanText = sanitizeProxyAddressesInBody(
    parsed.text,
    allProxyAddressesToSanitize,
    senderEmailAddress
  );
  const cleanHtml = sanitizeProxyAddressesInBody(
    parsed.html,
    allProxyAddressesToSanitize,
    senderEmailAddress
  );

  // 5. Resend API 経由で本来の宛先（To および Cc）へ一括送信
  await sendEmailViaResend(
    {
      from: senderFrom,
      to: finalToList,
      cc: resolvedCcList.length > 0 ? resolvedCcList : undefined,
      subject: parsed.subject || '(No Subject)',
      text: cleanText,
      html: cleanHtml,
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
