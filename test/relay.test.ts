import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { Env } from '../src/types';
import { createEncryptedToken, decryptToken } from '../src/crypto';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';

describe('PrismPost Email Relay Integration', () => {
  const env: Env = {
    ALLOWED_GMAIL_ADDRESS: 'my-personal@gmail.com',
    SECRET_KEY: 'test_super_secret_key_32_bytes_prismpost',
    RESEND_API_KEY: 're_test_dummy_key_12345',
    DEFAULT_SENDER_NAME: 'PrismPost Team',
    TOKEN_EXPIRATION_DAYS: '30',
  };

  const mockCtx = {} as ExecutionContext;

  function createMockRawStream(rawContent: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(rawContent);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('4.1 Inbound Relay Flow', () => {
    it('should forward inbound email with encrypted Reply-To proxy header', async () => {
      const rawEmail = [
        'From: client@example.com',
        'To: info@customdomain.com',
        'Subject: Inquiry regarding services',
        'Message-ID: <msg123@example.com>',
        '',
        'Hello, I would like to ask about your service.',
      ].join('\r\n');

      const mockHeaders = new Headers({
        'from': 'client@example.com',
        'to': 'info@customdomain.com',
        'subject': 'Inquiry regarding services',
      });

      let forwardedTo = '';
      let forwardedHeaders: Headers | undefined;

      const mockMessage: ForwardableEmailMessage = {
        from: 'client@example.com',
        to: 'info@customdomain.com',
        headers: mockHeaders,
        raw: createMockRawStream(rawEmail),
        rawSize: rawEmail.length,
        forward: vi.fn(async (rcptTo: string, headers?: Headers) => {
          forwardedTo = rcptTo;
          forwardedHeaders = headers;
        }),
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage;

      await worker.email(mockMessage, env, mockCtx);

      // 個人Gmailに転送されたか
      expect(mockMessage.forward).toHaveBeenCalledTimes(1);
      expect(forwardedTo).toBe(env.ALLOWED_GMAIL_ADDRESS);

      // Reply-To ヘッダーが書き換えられているか
      expect(forwardedHeaders).toBeDefined();
      const replyTo = forwardedHeaders?.get('Reply-To');
      expect(replyTo).toBeDefined();
      expect(replyTo).toMatch(/^reply\+([A-Za-z0-9_-]+)@customdomain\.com$/);

      // トークンを復号して元の情報が保持されているかを検証
      const token = replyTo!.match(/^reply\+([A-Za-z0-9_-]+)@customdomain\.com$/)![1];
      const payload = await decryptToken(token, env.SECRET_KEY);

      expect(payload.originalFrom).toBe('client@example.com');
      expect(payload.targetDomain).toBe('customdomain.com');
      expect(payload.originalTo).toBe('info@customdomain.com');
    });
  });

  describe('4.2 Outbound Re-send Flow', () => {
    it('should resend email via Resend API when replied from personal Gmail with valid SPF and token', async () => {
      const originalPayload = {
        originalFrom: 'client@example.com',
        targetDomain: 'customdomain.com',
        originalTo: 'info@customdomain.com',
        timestamp: Date.now(),
      };
      const token = await createEncryptedToken(originalPayload, env.SECRET_KEY);
      const proxyRecipient = `reply+${token}@customdomain.com`;

      const replyRawEmail = [
        'From: my-personal@gmail.com',
        `To: ${proxyRecipient}`,
        'Subject: Re: Inquiry regarding services',
        'In-Reply-To: <msg123@example.com>',
        'References: <msg123@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Thank you for reaching out! We are happy to help.',
      ].join('\r\n');

      const mockHeaders = new Headers({
        'from': 'my-personal@gmail.com',
        'to': proxyRecipient,
        'subject': 'Re: Inquiry regarding services',
        'in-reply-to': '<msg123@example.com>',
        'references': '<msg123@example.com>',
        'received-spf': 'pass (cloudflare.com: domain of my-personal@gmail.com designates 209.85.220.41 as permitted sender)',
      });

      let resendRequestBody: any = null;
      let resendAuthHeader: string | null = null;

      // fetch (Resend API) のモック
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        if (url.toString().includes('api.resend.com/emails')) {
          resendAuthHeader = init.headers.Authorization;
          resendRequestBody = JSON.parse(init.body as string);
          return new Response(JSON.stringify({ id: 'resend_email_id_abc123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const mockMessage = {
        from: 'my-personal@gmail.com',
        to: proxyRecipient,
        headers: mockHeaders,
        raw: createMockRawStream(replyRawEmail),
        rawSize: replyRawEmail.length,
        forward: vi.fn(),
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage;

      await worker.email(mockMessage, env, mockCtx);

      // Resend API の呼び出しを検証
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(resendAuthHeader).toBe(`Bearer ${env.RESEND_API_KEY}`);
      expect(resendRequestBody).toBeDefined();

      // 送信元が独自ドメイン（info@customdomain.com）になっているか
      expect(resendRequestBody.from).toBe('PrismPost Team <info@customdomain.com>');
      // 送信先が本来のクライアント宛（client@example.com）になっているか
      expect(resendRequestBody.to).toEqual(['client@example.com']);
      expect(resendRequestBody.subject).toBe('Re: Inquiry regarding services');
      expect(resendRequestBody.text).toContain('Thank you for reaching out');

      // スレッド整合性の維持 (In-Reply-To, References)
      expect(resendRequestBody.headers).toEqual({
        'In-Reply-To': '<msg123@example.com>',
        'References': '<msg123@example.com>',
      });

      // 拒否や転送は呼ばれていないこと
      expect(mockMessage.setReject).not.toHaveBeenCalled();
      expect(mockMessage.forward).not.toHaveBeenCalled();
    });

    it('should reject email if SPF and DKIM authentication fails', async () => {
      const mockHeaders = new Headers({
        'from': 'my-personal@gmail.com',
        'to': 'reply+sometoken@customdomain.com',
        'received-spf': 'softfail (cloudflare.com: IP not permitted)',
      });

      const mockMessage = {
        from: 'my-personal@gmail.com',
        to: 'reply+sometoken@customdomain.com',
        headers: mockHeaders,
        raw: createMockRawStream(''),
        rawSize: 0,
        forward: vi.fn(),
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage;

      await expect(worker.email(mockMessage, env, mockCtx)).rejects.toThrow(
        /SPF\/DKIM verification failed/
      );

      expect(mockMessage.setReject).toHaveBeenCalledWith(
        expect.stringContaining('SPF/DKIM verification failed')
      );
    });

    it('should notify personal Gmail and reject if token is invalid or expired', async () => {
      const mockHeaders = new Headers({
        'from': 'my-personal@gmail.com',
        'to': 'reply+INVALIDTOKEN123@customdomain.com',
        'received-spf': 'pass (cloudflare.com: sender authenticated)',
      });

      let resendNotificationSent = false;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        if (url.toString().includes('api.resend.com/emails')) {
          const body = JSON.parse(init.body as string);
          if (body.to.includes(env.ALLOWED_GMAIL_ADDRESS)) {
            resendNotificationSent = true;
          }
          return new Response(JSON.stringify({ id: 'resend_error_notify_id' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const mockMessage = {
        from: 'my-personal@gmail.com',
        to: 'reply+INVALIDTOKEN123@customdomain.com',
        headers: mockHeaders,
        raw: createMockRawStream(''),
        rawSize: 0,
        forward: vi.fn(),
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage;

      await expect(worker.email(mockMessage, env, mockCtx)).rejects.toThrow(
        /Decryption failed/
      );

      // 個人Gmailにエラー通知が送られたこと
      expect(resendNotificationSent).toBe(true);
      expect(mockMessage.setReject).toHaveBeenCalled();
    });

    it('should forward attachments correctly in outbound resend', async () => {
      const originalPayload = {
        originalFrom: 'partner@example.com',
        targetDomain: 'sales.domain.com',
        originalTo: 'sales@sales.domain.com',
        timestamp: Date.now(),
      };
      const token = await createEncryptedToken(originalPayload, env.SECRET_KEY);
      const proxyRecipient = `reply+${token}@sales.domain.com`;

      // MIME マルチパートのメール（添付ファイル付き）
      const boundary = '----=_Part_123_456';
      const rawEmailWithAttachment = [
        'From: my-personal@gmail.com',
        `To: ${proxyRecipient}`,
        'Subject: Re: Estimate requested',
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please find the attached document.',
        `--${boundary}`,
        'Content-Type: text/plain; name="estimate.txt"',
        'Content-Disposition: attachment; filename="estimate.txt"',
        'Content-Transfer-Encoding: base64',
        '',
        'VGhhbmtzIGZvciB5b3VyIGJ1c2luZXNzIQ==', // "Thanks for your business!" in base64
        `--${boundary}--`,
      ].join('\r\n');

      const mockHeaders = new Headers({
        'from': 'my-personal@gmail.com',
        'to': proxyRecipient,
        'subject': 'Re: Estimate requested',
        'received-spf': 'pass (google.com)',
      });

      let sentPayload: any = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        if (url.toString().includes('api.resend.com/emails')) {
          sentPayload = JSON.parse(init.body as string);
          return new Response(JSON.stringify({ id: 'resend_attachment_ok' }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const mockMessage = {
        from: 'my-personal@gmail.com',
        to: proxyRecipient,
        headers: mockHeaders,
        raw: createMockRawStream(rawEmailWithAttachment),
        rawSize: rawEmailWithAttachment.length,
        forward: vi.fn(),
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage;

      await worker.email(mockMessage, env, mockCtx);

      expect(sentPayload).toBeDefined();
      expect(sentPayload.from).toBe('PrismPost Team <sales@sales.domain.com>');
      expect(sentPayload.to).toEqual(['partner@example.com']);
      expect(sentPayload.attachments).toBeDefined();
      expect(sentPayload.attachments.length).toBe(1);
      expect(sentPayload.attachments[0].filename).toBe('estimate.txt');
      expect(sentPayload.attachments[0].content).toBe('VGhhbmtzIGZvciB5b3VyIGJ1c2luZXNzIQ==');
    });

    it('should support multiple custom domains seamlessly and statelessly', async () => {
      // ドメインA宛の返信
      const tokenA = await createEncryptedToken(
        {
          originalFrom: 'user-a@example.com',
          targetDomain: 'domain-a.com',
          originalTo: 'hello@domain-a.com',
          timestamp: Date.now(),
        },
        env.SECRET_KEY
      );

      // ドメインB宛の返信
      const tokenB = await createEncryptedToken(
        {
          originalFrom: 'user-b@example.com',
          targetDomain: 'domain-b.com',
          originalTo: 'support@domain-b.com',
          timestamp: Date.now(),
        },
        env.SECRET_KEY
      );

      const capturedFroms: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        if (url.toString().includes('api.resend.com/emails')) {
          const body = JSON.parse(init.body as string);
          capturedFroms.push(body.from);
          return new Response(JSON.stringify({ id: 'ok' }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      // メールA送信
      await worker.email(
        {
          from: 'my-personal@gmail.com',
          to: `reply+${tokenA}@domain-a.com`,
          headers: new Headers({ 'received-spf': 'pass' }),
          raw: createMockRawStream('Hello A'),
          rawSize: 7,
          forward: vi.fn(),
          setReject: vi.fn(),
        } as unknown as ForwardableEmailMessage,
        env,
        mockCtx
      );

      // メールB送信
      await worker.email(
        {
          from: 'my-personal@gmail.com',
          to: `reply+${tokenB}@domain-b.com`,
          headers: new Headers({ 'received-spf': 'pass' }),
          raw: createMockRawStream('Hello B'),
          rawSize: 7,
          forward: vi.fn(),
          setReject: vi.fn(),
        } as unknown as ForwardableEmailMessage,
        env,
        mockCtx
      );

      expect(capturedFroms).toEqual([
        'PrismPost Team <hello@domain-a.com>',
        'PrismPost Team <support@domain-b.com>',
      ]);
    });
  });
});
