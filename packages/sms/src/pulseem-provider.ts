import { randomUUID } from 'node:crypto';
import { normalizeIsraeliPhone } from './phone.js';
import type { SmsMessage, SmsProvider, SmsSendResult } from './provider.js';

/**
 * SMS provider for Pulseem (pulseem.co.il). Pulseem also offers WhatsApp and
 * email/newsletter sends via the same account; this provider only covers
 * transactional SMS (the customer-OTP path). WhatsApp + newsletter can be
 * added as separate providers later, since they have different shapes and
 * different per-message economics.
 *
 * API reference: https://api.pulseem.com/swagger/index.html
 *   - Auth: APIKEY header (the literal string "APIKEY", not "X-Api-Key" —
 *     verified with Pulseem support 2026-06-21; the swagger says "X-Api-Key"
 *     but their server only looks for "APIKEY", which produces a 403
 *     "Invalid API Key!" response on the wrong header name)
 *   - SMS endpoint: POST /api/v1/SmsApi/SendSms
 *   - Recipients are array-shaped (toNumberList + textList, parallel arrays).
 *     We send one message at a time per the SmsProvider contract, so each
 *     call ships a single-element array.
 *
 * Response shape is not fully documented in the swagger — the provider parses
 * defensively (HTTP status drives the ok/error decision; any structured
 * response body is surfaced for logging).
 */
export interface PulseemOptions {
  /** Pulseem API key from the Pulseem dashboard (treat as secret). */
  apiKey: string;
  /** Sender identifier (alphanumeric like 'MEMESH', or a numeric number). */
  fromNumber: string;
  /** Base URL override. Defaults to the documented production base. */
  baseUrl?: string;
  /** Override the global fetch (used by tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.pulseem.com';
const SEND_SMS_PATH = '/api/v1/SmsApi/SendSms';

interface PulseemSmsBody {
  sendId: string;
  isAsync: boolean;
  smsSendData: {
    fromNumber: string;
    toNumberList: string[];
    textList: string[];
    referenceList?: string[];
  };
}

interface PulseemResponse {
  // The exact response shape is not in the swagger; common fields seen in
  // their responses include status / message / id / sendId. We only use these
  // for logging — the HTTP status code is what drives success/failure.
  status?: number | string;
  message?: string;
  id?: string | number;
  sendId?: string;
  [key: string]: unknown;
}

export class PulseemProvider implements SmsProvider {
  readonly name = 'pulseem';
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fromNumber: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PulseemOptions) {
    if (!options.apiKey) throw new Error('[sms:pulseem] apiKey is required');
    if (!options.fromNumber) throw new Error('[sms:pulseem] fromNumber (sender id) is required');
    this.apiKey = options.apiKey;
    this.fromNumber = options.fromNumber;
    const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.endpoint = `${base}${SEND_SMS_PATH}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    let toNormalized: string;
    try {
      toNormalized = normalizeIsraeliPhone(message.to);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'invalid_phone';
      return { ok: false, error };
    }

    const sendId = randomUUID();
    const body: PulseemSmsBody = {
      sendId,
      isAsync: false,
      smsSendData: {
        fromNumber: this.fromNumber,
        toNumberList: [toNormalized],
        textList: [message.body],
      },
    };
    const masked = maskPhone(toNormalized);

    console.info('[sms:pulseem] sending', { to: masked, length: message.body.length, sendId });

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
      console.warn('[sms:pulseem] failed', { to: masked, sendId, error });
      return { ok: false, error: `network: ${error}` };
    }

    let parsed: PulseemResponse | undefined;
    let rawText = '';
    try {
      rawText = await response.text();
      parsed = rawText ? (JSON.parse(rawText) as PulseemResponse) : undefined;
    } catch {
      // Non-JSON 200 (some endpoints return empty bodies on success) — keep
      // rawText so it still shows up in the failure log if status was bad.
    }

    if (!response.ok) {
      const error = parsed?.message ?? (rawText.slice(0, 200) || `http_${response.status}`);
      console.warn('[sms:pulseem] failed', { to: masked, sendId, status: response.status, error });
      return { ok: false, error };
    }

    const id =
      parsed?.id !== undefined
        ? String(parsed.id)
        : parsed?.sendId !== undefined
          ? String(parsed.sendId)
          : sendId;
    console.info('[sms:pulseem] sent', { to: masked, sendId, status: response.status, id });
    return { ok: true, id };
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 3) return '***';
  return `${phone.slice(0, 3)}***`;
}
