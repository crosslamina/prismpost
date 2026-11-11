import { TokenPayload, CompactTokenData } from './types';
import { extractEmailAddress } from './security';

/**
 * 鍵導出: 任意の文字列秘密鍵から SHA-256 で 256bit の CryptoKey を作成
 */
async function getCryptoKey(secretKey: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest('SHA-256', enc.encode(secretKey));
  return await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Uint8Array を Base64URL 文字列に変換
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64URL 文字列を Uint8Array に変換
 */
export function base64UrlToBytes(base64Url: string): Uint8Array {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad) {
    base64 += '='.repeat(4 - pad);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 可読プロキシアドレスを生成
 * 形式: {senderLocal}+{recipientLocal}={recipientDomain}@{targetDomain}
 * 例: info+client=example.com@yourdomain.com
 */
export function createReadableProxyAddress(
  originalFrom: string,
  targetDomain: string,
  originalTo?: string
): string {
  const cleanFrom = extractEmailAddress(originalFrom);
  const fromAtIdx = cleanFrom.lastIndexOf('@');
  if (fromAtIdx === -1) {
    throw new Error(`Invalid originalFrom email address: ${originalFrom}`);
  }
  const recipientLocal = cleanFrom.slice(0, fromAtIdx);
  const recipientDomain = cleanFrom.slice(fromAtIdx + 1).toLowerCase();

  let senderLocal = 'info';
  if (originalTo) {
    const cleanTo = extractEmailAddress(originalTo);
    const toAtIdx = cleanTo.lastIndexOf('@');
    const rawLocal = toAtIdx !== -1 ? cleanTo.slice(0, toAtIdx) : cleanTo;
    // すでに + が含まれている場合はベース部分のみ取得
    senderLocal = rawLocal.split('+')[0] || 'info';
  }

  return `${senderLocal}+${recipientLocal}=${recipientDomain}@${targetDomain.toLowerCase()}`;
}

/**
 * 可読プロキシアドレス（{senderLocal}+{recipientLocal}={recipientDomain}@{targetDomain}）を解析
 * 該当しない形式（暗号化トークンなど）の場合は null を返す
 */
export function parseReadableProxyAddress(proxyAddress: string): TokenPayload | null {
  const clean = extractEmailAddress(proxyAddress);
  const atIdx = clean.lastIndexOf('@');
  if (atIdx === -1) return null;

  const localPart = clean.slice(0, atIdx);
  const targetDomain = clean.slice(atIdx + 1).toLowerCase();

  const plusIdx = localPart.indexOf('+');
  if (plusIdx === -1) return null;

  const prefixLocal = localPart.slice(0, plusIdx);
  const encodedTarget = localPart.slice(plusIdx + 1);

  // 可読アドレス形式は encodedTarget に '=' が含まれ、かつドメイン部分が続く
  const eqIdx = encodedTarget.lastIndexOf('=');
  if (eqIdx <= 0 || eqIdx === encodedTarget.length - 1) {
    return null;
  }

  const recipientLocal = encodedTarget.slice(0, eqIdx);
  const recipientDomain = encodedTarget.slice(eqIdx + 1).toLowerCase();

  // ドメイン形式の簡易バリデーション（Base64トークンとの誤認防止）
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(recipientDomain)) {
    return null;
  }

  const senderLocal =
    prefixLocal.toLowerCase() === 'reply' || prefixLocal.toLowerCase() === 'to'
      ? 'info'
      : prefixLocal;

  return {
    originalFrom: `${recipientLocal}@${recipientDomain}`,
    targetDomain,
    originalTo: `${senderLocal}@${targetDomain}`,
    timestamp: Date.now(),
  };
}

/**
 * ペイロードをコンパクトなバイナリ構造にシリアライズして暗号化し、Base64URL トークンを生成
 */
export async function createEncryptedToken(
  payload: TokenPayload,
  secretKey: string
): Promise<string> {
  const key = await getCryptoKey(secretKey);

  // originalTo が "@{targetDomain}" で終わる場合はローカルパートのみ保持してバイト数を削減
  let compactTo = payload.originalTo || '';
  const domainSuffix = `@${payload.targetDomain.toLowerCase()}`;
  if (compactTo.toLowerCase().endsWith(domainSuffix)) {
    compactTo = compactTo.slice(0, compactTo.length - domainSuffix.length);
  }

  // バイナリフォーマット: [Version=1 (1B)] [Timestamp sec (4B Uint32BE)] [from\n + domain\n + compactTo]
  const timestampSec = Math.floor(payload.timestamp / 1000);
  const textPart = `${payload.originalFrom}\n${payload.targetDomain}\n${compactTo}`;
  const textBytes = new TextEncoder().encode(textPart);

  const plaintext = new Uint8Array(5 + textBytes.length);
  plaintext[0] = 0x01; // Version 1 binary layout
  const view = new DataView(plaintext.buffer);
  view.setUint32(1, timestampSec, false);
  plaintext.set(textBytes, 5);

  // 12バイトの初期化ベクトル (IV) を生成
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: 128,
    },
    key,
    plaintext
  );

  const encryptedBytes = new Uint8Array(encryptedBuffer);

  // [IV 12バイト] + [Ciphertext + Tag] を結合
  const combined = new Uint8Array(iv.length + encryptedBytes.length);
  combined.set(iv, 0);
  combined.set(encryptedBytes, iv.length);

  return bytesToBase64Url(combined);
}

/**
 * Base64URL トークンを復号し、有効期限を検証して元のペイロードを取得
 * コンパクトバイナリ形式（v1）および旧JSON形式の両方に互換対応
 */
export async function decryptToken(
  token: string,
  secretKey: string,
  maxAgeDays: number = 30
): Promise<TokenPayload> {
  let combined: Uint8Array;
  try {
    combined = base64UrlToBytes(token);
  } catch (err) {
    throw new Error('Invalid base64url token format');
  }

  // IV(12バイト) + Tag(16バイト) = 最低28バイト必要
  if (combined.length < 28) {
    throw new Error('Token length is too short');
  }

  const iv = combined.slice(0, 12);
  const ciphertextWithTag = combined.slice(12);

  const key = await getCryptoKey(secretKey);

  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: 128,
      },
      key,
      ciphertextWithTag
    );
  } catch (err) {
    throw new Error('Failed to decrypt token: MAC check failed or corrupted data');
  }

  const decryptedBytes = new Uint8Array(decryptedBuffer);
  const dec = new TextDecoder();

  let originalFrom: string;
  let targetDomain: string;
  let originalTo: string | undefined;
  let timestampMs: number;

  if (decryptedBytes[0] === 0x01 && decryptedBytes.length >= 6) {
    // Version 1 コンパクトバイナリ形式
    const view = new DataView(
      decryptedBytes.buffer,
      decryptedBytes.byteOffset,
      decryptedBytes.byteLength
    );
    const timestampSec = view.getUint32(1, false);
    timestampMs = timestampSec * 1000;

    const textPart = dec.decode(decryptedBytes.subarray(5));
    const parts = textPart.split('\n');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw new Error('Decrypted binary payload missing required fields');
    }
    originalFrom = parts[0];
    targetDomain = parts[1];
    const rawTo = parts.slice(2).join('\n');
    if (rawTo) {
      originalTo = rawTo.includes('@') ? rawTo : `${rawTo}@${targetDomain}`;
    }
  } else {
    // 旧JSON形式フォールバック
    const jsonStr = dec.decode(decryptedBuffer);
    const compact: CompactTokenData = JSON.parse(jsonStr);

    if (!compact.f || !compact.d || typeof compact.t !== 'number') {
      throw new Error('Decrypted payload missing required fields');
    }
    originalFrom = compact.f;
    targetDomain = compact.d;
    originalTo = compact.o;
    timestampMs = compact.t * 1000;
  }

  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  if (now - timestampMs > maxAgeMs) {
    throw new Error(`Token expired (exceeded ${maxAgeDays} days)`);
  }

  return {
    originalFrom,
    targetDomain,
    originalTo,
    timestamp: timestampMs,
  };
}
