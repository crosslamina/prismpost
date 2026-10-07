import { describe, it, expect } from 'vitest';
import { createEncryptedToken, decryptToken, bytesToBase64Url, base64UrlToBytes } from '../src/crypto';
import { TokenPayload } from '../src/types';

describe('Crypto Module', () => {
  const secretKey = 'super_secret_test_key_for_prismpost_32bytes';

  it('should encrypt and decrypt payload successfully', async () => {
    const payload: TokenPayload = {
      originalFrom: 'client@example.com',
      targetDomain: 'yourdomain.com',
      originalTo: 'info@yourdomain.com',
      timestamp: Date.now(),
    };

    const token = await createEncryptedToken(payload, secretKey);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    // Base64URL 文字セット (a-z, A-Z, 0-9, -, _) のみであること
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const decrypted = await decryptToken(token, secretKey);
    expect(decrypted.originalFrom).toBe(payload.originalFrom);
    expect(decrypted.targetDomain).toBe(payload.targetDomain);
    expect(decrypted.originalTo).toBe(payload.originalTo);
    // 秒単位丸めのため1秒以内の誤差を許容
    expect(Math.abs(decrypted.timestamp - payload.timestamp)).toBeLessThan(1000);
  });

  it('should handle optional originalTo gracefully', async () => {
    const payload: TokenPayload = {
      originalFrom: 'sender@customer.org',
      targetDomain: 'company.com',
      timestamp: Date.now(),
    };

    const token = await createEncryptedToken(payload, secretKey);
    const decrypted = await decryptToken(token, secretKey);

    expect(decrypted.originalFrom).toBe(payload.originalFrom);
    expect(decrypted.targetDomain).toBe(payload.targetDomain);
    expect(decrypted.originalTo).toBeUndefined();
  });

  it('should fail when decrypting with a different secret key', async () => {
    const payload: TokenPayload = {
      originalFrom: 'client@example.com',
      targetDomain: 'yourdomain.com',
      timestamp: Date.now(),
    };

    const token = await createEncryptedToken(payload, secretKey);
    const wrongKey = 'different_wrong_secret_key_1234567890';

    await expect(decryptToken(token, wrongKey)).rejects.toThrow(
      /Failed to decrypt token/
    );
  });

  it('should reject tampered tokens', async () => {
    const payload: TokenPayload = {
      originalFrom: 'client@example.com',
      targetDomain: 'yourdomain.com',
      timestamp: Date.now(),
    };

    const token = await createEncryptedToken(payload, secretKey);
    // トークンの一部を改ざん
    const tampered = token.slice(0, 10) + (token[10] === 'a' ? 'b' : 'a') + token.slice(11);

    await expect(decryptToken(tampered, secretKey)).rejects.toThrow();
  });

  it('should reject expired tokens', async () => {
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const payload: TokenPayload = {
      originalFrom: 'client@example.com',
      targetDomain: 'yourdomain.com',
      timestamp: fortyDaysAgo,
    };

    const token = await createEncryptedToken(payload, secretKey);

    // 有効期限30日で検証した場合、期限切れエラーになること
    await expect(decryptToken(token, secretKey, 30)).rejects.toThrow(
      /Token expired/
    );

    // 有効期限50日なら復号できること
    const validWith50Days = await decryptToken(token, secretKey, 50);
    expect(validWith50Days.originalFrom).toBe('client@example.com');
  });

  it('should correctly encode and decode bytes to Base64URL', () => {
    const original = new Uint8Array([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    const encoded = bytesToBase64Url(original);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');

    const decoded = base64UrlToBytes(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});
