import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { Env } from '../src/types';
import { createEncryptedToken } from '../src/crypto';
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
    it('should forward inbound email with readable Reply-To header under 64 chars and prefer MIME From/Reply-To over bounce envelope', async () => {
      const rawEmail = [
        'From: "Customer Name" <client@example.com>',
        'Reply-To: client-reply@example.com',
        'To: info@customdomain.com',
        'Subject: Inquiry regarding services',
        'Message-ID: <msg123@example.com>',
        '',
        'Hello, I would like to ask about your service.',
      ].join('\r\n');

      const mockHeaders = new Headers({
        'from': 'Customer Name <client@example.com>',
        'reply-to': 'client-reply@example.com',
        'to': 'info@customdomain.com',
        'subject': 'Inquiry regarding services',
      });

      let forwardedTo = '';
      let forwardedHeaders: Headers | undefined;

      // message.from が SES 等のバウンスアドレスになっていてもヘッダーの Reply-To / From を優先することを確認
      const mockMessage: ForwardableEmailMessage = {
        from: '0100018f-bounce@amazonses.com',
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

      expect(mockMessage.forward).toHaveBeenCalledTimes(1);
      expect(forwardedTo).toBe(env.ALLOWED_GMAIL_ADDRESS);

      expect(forwardedHeaders).toBeDefined();
      const replyTo = forwardedHeaders?.get('Reply-To');
      expect(replyTo).toBe('info+client-reply=example.com@customdomain.com');
      expect(replyTo!.split('@')[0].length).toBeLessThanOrEqual(64);
    });
  });

  describe('4.2 Outbound Re-send Flow', () => {
    it('should resend email via Resend API using readable proxy address and mask proxy address in quoted body', async () => {
      const proxyRecipient = 'info+client=example.com@customdomain.com';

      const replyRawEmail = [
        'From: my-personal@gmail.com',
        `To: ${proxyRecipient}`,
        'Subject: Re: Inquiry regarding services',
        'In-Reply-To: <msg123@example.com>',
        'References: <msg123@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Thank you for reaching out! We are happy to help.',
        `On Wed, Nov 11, 2026, <${proxyRecipient}> wrote:`,
        '> Hello',
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

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(resendAuthHeader).toBe(`Bearer ${env.RESEND_API_KEY}`);
      expect(resendRequestBody).toBeDefined();

      expect(resendRequestBody.from).toBe('PrismPost Team <info@customdomain.com>');
      expect(resendRequestBody.to).toEqual(['client@example.com']);
      expect(resendRequestBody.subject).toBe('Re: Inquiry regarding services');
      expect(resendRequestBody.text).toContain('Thank you for reaching out');
      // 引用文中のプロキシアドレスが info@customdomain.com にマスクされていることを確認
      expect(resendRequestBody.text).not.toContain(proxyRecipient);
      expect(resendRequestBody.text).toContain('<info@customdomain.com>');

      expect(resendRequestBody.headers).toEqual({
        'In-Reply-To': '<msg123@example.com>',
        'References': '<msg123@example.com>',
      });

      expect(mockMessage.setReject).not.toHaveBeenCalled();
      expect(mockMessage.forward).not.toHaveBeenCalled();
    });

    it('should also support legacy encrypted token format (reply+{token}@domain)', async () => {
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
        'Subject: Re: Token reply',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Reply via encrypted token.',
      ].join('\r\n');

      const mockHeaders = new Headers({
        'from': 'my-personal@gmail.com',
        'to': proxyRecipient,
        'subject': 'Re: Token reply',
        'received-spf': 'pass (cloudflare.com: domain of my-personal@gmail.com designates 209.85.220.41 as permitted sender)',
      });

      let resendRequestBody: any = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        if (url.toString().includes('api.resend.com/emails')) {
          resendRequestBody = JSON.parse(init.body as string);
          return new Response(JSON.stringify({ id: 'resend_ok' }), { status: 200 });
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
      expect(resendRequestBody.from).toBe('PrismPost Team <info@customdomain.com>');
      expect(resendRequestBody.to).toEqual(['client@example.com']);
    });

    it('should reject email if SPF and DKIM authentication fails', async () => {
      const mockHeaders = new Headers({
        'from': 'my-personal@gmail.com',
        'to': 'info+client=example.com@customdomain.com',
        'received-spf': 'softfail (cloudflare.com: IP not permitted)',
      });

      const mockMessage = {
        from: 'my-personal@gmail.com',
        to: 'info+client=example.com@customdomain.com',
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

      expect(resendNotificationSent).toBe(true);
      expect(mockMessage.setReject).toHaveBeenCalled();
    });

    it('should forward attachments correctly in outbound resend', async () => {
      const proxyRecipient = 'sales+partner=example.com@sales.domain.com';

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
        'VGhhbmtzIGZvciB5b3VyIGJ1c2luZXNzIQ==',
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
      const capturedFroms: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        if (url.toString().includes('api.resend.com/emails')) {
          const body = JSON.parse(init.body as string);
          capturedFroms.push(body.from);
          return new Response(JSON.stringify({ id: 'ok' }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await worker.email(
        {
          from: 'my-personal@gmail.com',
          to: 'hello+user-a=example.com@domain-a.com',
          headers: new Headers({ 'received-spf': 'pass' }),
          raw: createMockRawStream('Hello A'),
          rawSize: 7,
          forward: vi.fn(),
          setReject: vi.fn(),
        } as unknown as ForwardableEmailMessage,
        env,
        mockCtx
      );

      await worker.email(
        {
          from: 'my-personal@gmail.com',
          to: 'support+user-b=example.com@domain-b.com',
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

    it('should support CC recipients via proxy addresses and prevent duplicate Resend calls across multiple envelope invocations', async () => {
      const toProxy = 'info+client=example.com@customdomain.com';
      const ccProxy1 = 'info+boss=example.com@customdomain.com';
      const ccProxy2 = 'info+colleague=partner.org@customdomain.com';

      const rawMimeWithCc = [
        'From: my-personal@gmail.com',
        `To: ${toProxy}`,
        `Cc: ${ccProxy1}, ${ccProxy2}`,
        'Subject: Project Update with CC',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hello everyone, here is the project update.',
      ].join('\r\n');

      const sentPayloads: any[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        if (url.toString().includes('api.resend.com/emails')) {
          sentPayloads.push(JSON.parse(init.body as string));
          return new Response(JSON.stringify({ id: 'resend_cc_ok' }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      // 1回目の起動（主宛先 To のエンベロープ）-> Resend API で To + Cc 全員へ1通送信される
      await worker.email(
        {
          from: 'my-personal@gmail.com',
          to: toProxy,
          headers: new Headers({ 'received-spf': 'pass (google.com)' }),
          raw: createMockRawStream(rawMimeWithCc),
          rawSize: rawMimeWithCc.length,
          forward: vi.fn(),
          setReject: vi.fn(),
        } as unknown as ForwardableEmailMessage,
        env,
        mockCtx
      );

      // 2回目・3回目の起動（CC宛先のエンベロープ到着時）-> 重複送信防止によりスキップされる
      await worker.email(
        {
          from: 'my-personal@gmail.com',
          to: ccProxy1,
          headers: new Headers({ 'received-spf': 'pass (google.com)' }),
          raw: createMockRawStream(rawMimeWithCc),
          rawSize: rawMimeWithCc.length,
          forward: vi.fn(),
          setReject: vi.fn(),
        } as unknown as ForwardableEmailMessage,
        env,
        mockCtx
      );

      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].from).toBe('PrismPost Team <info@customdomain.com>');
      expect(sentPayloads[0].to).toEqual(['client@example.com']);
      expect(sentPayloads[0].cc).toEqual(['boss@example.com', 'colleague@partner.org']);
    });
  });
});
