import { randomUUID } from 'node:crypto';
import type { EmailMessage, EmailProvider, EmailSendResult } from './provider.js';

/**
 * Email provider for Pulseem (pulseem.co.il) — the same account that sends
 * SMS via `@memesh/sms`'s PulseemProvider. Builds on the SMS provider's
 * lessons:
 *
 * - Auth header is the literal string `APIKEY`, not the swagger-documented
 *   `X-Api-Key`. Verified for SMS 2026-06-21; same server backs the email
 *   endpoint so we use the same header here.
 * - Pulseem can return HTTP 200 with an application-level error body, so
 *   the HTTP status alone is not a reliable success signal. We defensively
 *   parse the body and treat `status !== "Success"` as a failure.
 *
 * Endpoint: `POST /api/v1/EmailApi/SendEmail`
 * Body shape mirrors the SMS endpoint's parallel-array convention: each
 * recipient field is an array (we ship single-element arrays per call).
 *
 * Pulseem accepts HTML only — there is no `text` field in `EmailSendData`.
 * Callers that pass a plain-text body without HTML get it wrapped in a
 * minimal RTL-safe `<pre>` so the message still renders.
 */
export interface PulseemEmailOptions {
  /** Pulseem API key from the Pulseem dashboard (treat as secret). */
  apiKey: string;
  /** Verified sender email, e.g. `noreply@memesh.co.il`. */
  fromEmail: string;
  /** Display name in the recipient's inbox, e.g. `Memesh`. */
  fromName: string;
  /** Base URL override. Defaults to the documented production base. */
  baseUrl?: string;
  /** Override the global fetch (used by tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.pulseem.com';
const SEND_EMAIL_PATH = '/api/v1/EmailApi/SendEmail';

interface PulseemEmailBody {
  sendId: string;
  emailSendData: {
    fromEmail: string;
    fromName: string;
    subject: string[];
    html: string[];
    toEmails: string[];
    toNames: string[];
    externalRef: string[];
  };
}

interface PulseemEmailResponseItem {
  toEmail?: string;
  reference?: string;
  message?: string;
}

interface PulseemEmailResponse {
  /**
   * Application-level status. "Success" means the email was accepted for
   * delivery. Pulseem still returns HTTP 200 on application failure (e.g.
   * unauthorized fromEmail, malformed recipient), so this field — not the
   * HTTP status — drives the ok/error decision.
   */
  status?: 'Success' | 'Error' | string;
  error?: string | null;
  success?: number;
  failure?: number;
  count?: number;
  sessionId?: string;
  sendId?: string;
  items?: PulseemEmailResponseItem[];
  [key: string]: unknown;
}

export class PulseemEmailProvider implements EmailProvider {
  readonly name = 'pulseem';
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PulseemEmailOptions) {
    if (!options.apiKey) throw new Error('[email:pulseem] apiKey is required');
    if (!options.fromEmail) throw new Error('[email:pulseem] fromEmail is required');
    if (!options.fromName) throw new Error('[email:pulseem] fromName is required');
    this.apiKey = options.apiKey;
    this.fromEmail = options.fromEmail;
    this.fromName = options.fromName;
    const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.endpoint = `${base}${SEND_EMAIL_PATH}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const to = message.to.trim();
    if (!to || !to.includes('@')) {
      return { ok: false, error: 'invalid_email' };
    }

    // Pulseem only accepts `html`. If the caller passed a plain-text body
    // (no html), wrap it as a minimal RTL pre-block so Hebrew renders the
    // way the SMS would.
    const html =
      message.html ??
      `<!doctype html><html lang="he" dir="rtl"><body><pre style="font-family: sans-serif; white-space: pre-wrap;">${escapeHtml(message.text)}</pre></body></html>`;

    const sendId = randomUUID();
    const body: PulseemEmailBody = {
      sendId,
      emailSendData: {
        fromEmail: this.fromEmail,
        fromName: this.fromName,
        subject: [message.subject],
        html: [html],
        toEmails: [to],
        toNames: [to],
        externalRef: [randomUUID()],
      },
    };
    const masked = maskEmail(to);

    console.info('[email:pulseem] sending', {
      to: masked,
      subjectLength: message.subject.length,
      htmlLength: html.length,
      sendId,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          APIKEY: this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'network_error';
      console.warn('[email:pulseem] failed', { to: masked, sendId, error });
      return { ok: false, error: `network: ${error}` };
    }

    let parsed: PulseemEmailResponse | undefined;
    let rawText = '';
    try {
      rawText = await response.text();
      parsed = rawText ? (JSON.parse(rawText) as PulseemEmailResponse) : undefined;
    } catch {
      // Non-JSON 200 — keep rawText for the failure log if status is bad.
    }

    if (!response.ok) {
      const error = parsed?.error ?? (rawText.slice(0, 200) || `http_${response.status}`);
      console.warn('[email:pulseem] failed', {
        to: masked,
        sendId,
        status: response.status,
        error,
      });
      return { ok: false, error };
    }

    if (parsed && parsed.status !== 'Success') {
      const error = parsed.error ?? `pulseem_status_${parsed.status ?? 'unknown'}`;
      console.warn('[email:pulseem] failed (http 200, app error)', {
        to: masked,
        sendId,
        status: parsed.status,
        error,
        success: parsed.success,
        failure: parsed.failure,
      });
      return { ok: false, error };
    }

    const id = parsed?.sessionId ?? parsed?.sendId ?? sendId;
    console.info('[email:pulseem] sent', {
      to: masked,
      sendId,
      status: response.status,
      id,
      itemMessage: parsed?.items?.[0]?.message,
    });
    return { ok: true, id };
  }
}

function maskEmail(email: string): string {
  // Show first 2 chars of the local part and the domain; everything else
  // becomes "***" so support tickets can correlate logs to a customer
  // without spraying full addresses through the log stream.
  const at = email.indexOf('@');
  if (at < 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `***${domain}`;
  return `${local.slice(0, 2)}***${domain}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
