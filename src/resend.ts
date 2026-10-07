import { ResendSendEmailParams, ResendSendEmailResponse } from './types';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Resend API を利用してメールを送信
 */
export async function sendEmailViaResend(
  params: ResendSendEmailParams,
  apiKey: string
): Promise<ResendSendEmailResponse> {
  const payload: Record<string, unknown> = {
    from: params.from,
    to: Array.isArray(params.to) ? params.to : [params.to],
    subject: params.subject,
  };

  if (params.text) {
    payload.text = params.text;
  }
  if (params.html) {
    payload.html = params.html;
  }
  if (params.headers && Object.keys(params.headers).length > 0) {
    payload.headers = params.headers;
  }
  if (params.attachments && params.attachments.length > 0) {
    payload.attachments = params.attachments;
  }

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseData = (await response.json().catch(() => ({}))) as ResendSendEmailResponse;

  if (!response.ok) {
    const errorMsg =
      responseData.message || `Resend API returned status ${response.status}: ${response.statusText}`;
    throw new Error(`Resend send failed: ${errorMsg}`);
  }

  return responseData;
}
