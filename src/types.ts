import type { ForwardableEmailMessage } from '@cloudflare/workers-types';

export interface Env {
  ALLOWED_GMAIL_ADDRESS: string;
  SECRET_KEY: string;
  RESEND_API_KEY: string;
  DEFAULT_SENDER_NAME?: string;
  TOKEN_EXPIRATION_DAYS?: string;
}

export interface TokenPayload {
  originalFrom: string;
  targetDomain: string;
  originalTo?: string;
  timestamp: number; // Unix timestamp in milliseconds
}

export interface CompactTokenData {
  f: string; // originalFrom
  d: string; // targetDomain
  o?: string; // originalTo
  t: number; // timestamp in seconds
}

export interface ResendAttachment {
  filename: string;
  content: string; // base64 encoded string
  content_type?: string;
}

export interface ResendSendEmailParams {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: ResendAttachment[];
}

export interface ResendSendEmailResponse {
  id?: string;
  name?: string;
  message?: string;
  statusCode?: number;
}
