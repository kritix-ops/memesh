import { randomUUID } from 'node:crypto';
import type { EmailMessage, EmailProvider, EmailSendResult } from './provider.js';

/**
 * Resend transactional email provider (resend.com). Hits the REST API
 * directly with `fetch` rather than pulling in the SDK — keeps the dependency
 * graph thin and matches the @memesh/sms pattern.
 *
 * API reference: https://resend.com/docs/api-reference/emails/send-email
 *   - Auth: `Authorization: Bearer <api-key>` header
 *   - Endpoint: POST https://api.resend.com/emails
 *   - Body: { from, to, subject, text, html?, headers? }
 *   - Response on success: { id: "<uuid>" }
 *   - A User-Agent header is required to avoid Resend's 403/1010 anti-bot
 *     gate when called from a fresh Node fetch:
 *     https://resend.com/docs/knowledge-base/403-error-1010
 */
export interface ResendOptions {
  /** Resend API key (treat as secret). Pull from RESEND_API_KEY env var. */
  apiKey: string;
  /** Verified sender, e.g. `Memesh <noreply@memesh.co.il>`. */
  from: string;
  /** Base URL override. Defaults to the documented production base. */
  baseUrl?: string;
  /** User-Agent string for the required UA header. */
  userAgent?: string;
  /** Override the global fetch (used by tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.resend.com';
const SEND_PATH = '/emails';
const DEFAULT_USER_AGENT = 'memesh-api/1.0';

interface ResendSuccess {
  id: string;
}

interface ResendError {
  // Resend errors come back with a structured body. We only need name + message
  // for logging; the HTTP status drives the ok/error decision.
  name?: string | undefined;
  message?: string | undefined;
  statusCode?: number | undefined;
}

export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendOptions) {
    if (!options.apiKey) throw new Error('[email:resend] apiKey is required');
    if (!options.from) throw new Error('[email:resend] from (verified sender) is required');
    this.apiKey = options.apiKey;
    this.from = options.from;
    const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.endpoint = `${base}${SEND_PATH}`;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const idempotencyKey = randomUUID();
    const body = {
      from: this.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html !== undefined && { html: message.html }),
    };
    const masked = maskEmail(message.to);
    console.info('[email:resend] sending', {
      to: masked,
      subject: message.subject,
      bodyLength: message.text.length,
      idempotencyKey,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          // Resend honors `Idempotency-Key` on POST /emails so a retry of the
          // same OTP delivery does not double-send if the first attempt's
          // response was lost. TTL is 24h on their side; our retry windows
          // are much shorter.
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'network_error';
      console.warn('[email:resend] failed', { to: masked, idempotencyKey, error });
      return { ok: false, error: `network: ${error}` };
    }

    let rawText = '';
    let parsedSuccess: ResendSuccess | undefined;
    let parsedError: ResendError | undefined;
    try {
      rawText = await response.text();
      if (rawText) {
        const obj = JSON.parse(rawText) as Record<string, unknown>;
        if (response.ok && typeof obj.id === 'string') {
          parsedSuccess = { id: obj.id };
        } else {
          parsedError = {
            name: typeof obj.name === 'string' ? obj.name : undefined,
            message: typeof obj.message === 'string' ? obj.message : undefined,
            statusCode: typeof obj.statusCode === 'number' ? obj.statusCode : undefined,
          };
        }
      }
    } catch {
      // Non-JSON body — keep rawText for the failure log.
    }

    if (!response.ok) {
      const error =
        parsedError?.message ??
        parsedError?.name ??
        (rawText.slice(0, 200) || `http_${response.status}`);
      console.warn('[email:resend] failed', {
        to: masked,
        idempotencyKey,
        status: response.status,
        error,
      });
      return { ok: false, error };
    }

    const id = parsedSuccess?.id ?? idempotencyKey;
    console.info('[email:resend] sent', {
      to: masked,
      idempotencyKey,
      status: response.status,
      id,
    });
    return { ok: true, id };
  }
}

/**
 * Mask the local-part of an email for logging. Keeps debugging useful (we can
 * tell different recipients apart by domain + first char) without leaking the
 * full address into log aggregators.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}
