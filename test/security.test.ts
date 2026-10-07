import { describe, it, expect } from 'vitest';
import {
  extractEmailAddress,
  isAllowedGmailSender,
  verifyEmailAuthentication,
} from '../src/security';

describe('Security Module', () => {
  describe('extractEmailAddress', () => {
    it('should extract plain email', () => {
      expect(extractEmailAddress('  user@EXAMPLE.COM  ')).toBe('user@example.com');
      expect(extractEmailAddress('  Reply+Token123@EXAMPLE.COM  ')).toBe('Reply+Token123@example.com');
    });

    it('should extract email from formatted name <address>', () => {
      expect(extractEmailAddress('John Doe <john.doe@example.com>')).toBe('john.doe@example.com');
      expect(extractEmailAddress('"Smith, Jane" <jane@gmail.com>')).toBe('jane@gmail.com');
    });

    it('should return empty string on empty input', () => {
      expect(extractEmailAddress('')).toBe('');
    });
  });

  describe('isAllowedGmailSender', () => {
    const allowed = 'my-account@gmail.com';

    it('should match identical address', () => {
      expect(isAllowedGmailSender('my-account@gmail.com', allowed)).toBe(true);
      expect(isAllowedGmailSender('MY-ACCOUNT@GMAIL.COM', allowed)).toBe(true);
    });

    it('should match address with display name', () => {
      expect(isAllowedGmailSender('My Name <my-account@gmail.com>', allowed)).toBe(true);
    });

    it('should reject unauthorized sender', () => {
      expect(isAllowedGmailSender('attacker@gmail.com', allowed)).toBe(false);
      expect(isAllowedGmailSender('stranger@example.com', allowed)).toBe(false);
    });
  });

  describe('verifyEmailAuthentication', () => {
    it('should pass if received-spf contains pass', () => {
      const headers = new Headers();
      headers.set('received-spf', 'pass (cloudflare.com: domain of my-account@gmail.com designates 209.85.220.41 as permitted sender)');

      const result = verifyEmailAuthentication(headers);
      expect(result.passed).toBe(true);
    });

    it('should pass if authentication-results contains spf=pass', () => {
      const headers = new Headers();
      headers.set('authentication-results', 'mx.cloudflare.com; spf=pass (google.com: domain of ...)');

      const result = verifyEmailAuthentication(headers);
      expect(result.passed).toBe(true);
    });

    it('should pass if authentication-results contains dkim=pass', () => {
      const headers = new Headers();
      headers.set('authentication-results', 'mx.cloudflare.com; dkim=pass header.i=@gmail.com');

      const result = verifyEmailAuthentication(headers);
      expect(result.passed).toBe(true);
    });

    it('should fail if received-spf is softfail or fail and no dkim pass', () => {
      const headers = new Headers();
      headers.set('received-spf', 'softfail (cloudflare.com: IP not allowed)');
      headers.set('authentication-results', 'mx.cloudflare.com; spf=softfail; dkim=fail');

      const result = verifyEmailAuthentication(headers);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('SPF/DKIM check failed');
    });

    it('should fail if authentication headers are missing', () => {
      const headers = new Headers();
      const result = verifyEmailAuthentication(headers);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Missing both');
    });
  });
});
