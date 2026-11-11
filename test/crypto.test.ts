import { describe, it, expect } from 'vitest';
import {
  createEncryptedToken,
  decryptToken,
  bytesToBase64Url,
  base64UrlToBytes,
  createReadableProxyAddress,
  parseReadableProxyAddress,
} from '../src/crypto';
import { TokenPayload } from '../src/types';

describe('Crypto & Proxy Address Module', () => {
  const secretKey = 'super_secret_test_key_for_prismpost_32bytes';

  describe('Readable Proxy Address (RFC 5321 <= 64 chars local-part)', () => {
    it('should generate and parse readable proxy address under 64 chars', () => {
      const proxy = createReadableProxyAddress(
        'client@example.com',
        'yourdomain.com',
        'info@yourdomain.com'
      );
      expect(proxy).toBe('info+client=example.com@yourdomain.com');

      const localPart = proxy.split('@')[0];
      expect(localPart.length).toBeLessThanOrEqual(64);

      const parsed = parseReadableProxyAddress(proxy);
      expect(parsed).not.toBeNull();
      expect(parsed!.originalFrom).toBe('client@example.com');
      expect(parsed!.targetDomain).toBe('yourdomain.com');
      expect(parsed!.originalTo).toBe('info@yourdomain.com');
    });

    it('should support composing new emails with custom sender local part or plus-tagged recipients', () => {
      const parsed = parseReadableProxyAddress('sales+john.doe+tag=company.co.jp@mydomain.jp');
      expect(parsed).not.toBeNull();
      expect(parsed!.originalFrom).toBe('john.doe+tag@company.co.jp');
      expect(parsed!.originalTo).toBe('sales@mydomain.jp');
      expect(parsed!.targetDomain).toBe('mydomain.jp');
    });

    it('should return null for legacy encrypted token addresses', () => {
      expect(parseReadableProxyAddress('reply+AbCdEf123456_Xyz@yourdomain.com')).toBeNull();
    });
  });

  describe('Encrypted Token (Compact Binary Format)', () => {
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
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

      const decrypted = await decryptToken(token, secretKey);
      expect(decrypted.originalFrom).toBe(payload.originalFrom);
      expect(decrypted.targetDomain).toBe(payload.targetDomain);
      expect(decrypted.originalTo).toBe(payload.originalTo);
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

      await expect(decryptToken(token, secretKey, 30)).rejects.toThrow(
        /Token expired/
      );

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
});
