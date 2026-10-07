import { TokenPayload, CompactTokenData } from './types';

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
 * ペイロードを暗号化して Base64URL トークンを生成
 */
export async function createEncryptedToken(
  payload: TokenPayload,
  secretKey: string
): Promise<string> {
  const key = await getCryptoKey(secretKey);

  // ペイロードをコンパクト化してトークン長を最小化
  const compact: CompactTokenData = {
    f: payload.originalFrom,
    d: payload.targetDomain,
    o: payload.originalTo,
    t: Math.floor(payload.timestamp / 1000),
  };

  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(compact));

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
 * @param token 暗号化トークン文字列
 * @param secretKey 秘密鍵
 * @param maxAgeDays 有効期限（日数、デフォルト30日）
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

  const dec = new TextDecoder();
  const jsonStr = dec.decode(decryptedBuffer);
  const compact: CompactTokenData = JSON.parse(jsonStr);

  if (!compact.f || !compact.d || typeof compact.t !== 'number') {
    throw new Error('Decrypted payload missing required fields');
  }

  const timestampMs = compact.t * 1000;
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  if (now - timestampMs > maxAgeMs) {
    throw new Error(`Token expired (exceeded ${maxAgeDays} days)`);
  }

  return {
    originalFrom: compact.f,
    targetDomain: compact.d,
    originalTo: compact.o,
    timestamp: timestampMs,
  };
}
