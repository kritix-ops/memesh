import { normalizeIsraeliPhone } from './phone.js';
import type { SmsMessage, SmsProvider, SmsSendResult } from './provider.js';

/**
 * SMS provider for 019 SMS (Israeli telco / "Telzar"). DRAFT — the wire format
 * is based on 019's documented XML schema projected to JSON, and Bearer-token
 * auth signaled by their token-management docs. The exact JSON example was not
 * verifiable from the docs page (JS-rendered, not in static HTML); the first
 * live attempt against a real account will confirm or correct the shape.
 *
 * Default endpoint is the test sandbox so wire-format mistakes log instead of
 * billing. Production is one env flip.
 *
 * See `_plans/2026-06-18-sms-provider-selection.md` for the unknowns this
 * implementation is hedging against.
 */
export interface Sms019Options {
  /** API token from 019 admin → Settings → API Token Management. */
  token: string;
  /** Sender ID (max 11 chars, Latin + digits). */
  source: string;
  /** Endpoint URL. Defaults to the test endpoint; flip to production when ready. */
  endpoint?: string;
  /** Override the global fetch (used by tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = 'https://019sms.co.il/api/test';

interface Sms019JsonBody {
  source: string;
  destinations: { phone: string };
  message: string;
}

interface Sms019JsonResponse {
  // 019 uses both numeric status codes and message strings; field names below
  // are the conservative guess. The provider parses defensively (any truthy
  // success indicator → ok, anything else → ok:false with whatever code we
  // can recover for logging).
  status?: number | string;
  message?: string;
  id?: string | number;
  // Catch-all for other top-level error fields we have not seen.
  [key: string]: unknown;
}

export class Sms019Provider implements SmsProvider {
  readonly name = '019';
  private readonly endpoint: string;
  private readonly token: string;
  private readonly source: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Sms019Options) {
    if (!options.token) throw new Error('[sms:019] token is required');
    if (!options.source) throw new Error('[sms:019] source (sender id) is required');
    if (options.source.length > 11) {
      throw new Error('[sms:019] source must be at most 11 characters');
    }
    this.token = options.token;
    this.source = options.source;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
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

    const body: Sms019JsonBody = {
      source: this.source,
      destinations: { phone: toNormalized },
      message: message.body,
    };
    const masked = maskPhone(toNormalized);

    console.info('[sms:019] sending', { to: masked, length: message.body.length });

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'network_error';
      console.warn('[sms:019] failed', { to: masked, error });
      return { ok: false, error: `network: ${error}` };
    }

    // Try to parse a JSON envelope; fall back to text for unstructured responses.
    let parsed: Sms019JsonResponse | undefined;
    let rawText = '';
    try {
      rawText = await response.text();
      parsed = rawText ? (JSON.parse(rawText) as Sms019JsonResponse) : undefined;
    } catch {
      // Non-JSON response (e.g. an HTML error page); keep rawText for logging.
    }

    if (!response.ok) {
      const error = parsed?.message ?? `http_${response.status}`;
      console.warn('[sms:019] failed', { to: masked, status: response.status, error });
      return { ok: false, error };
    }

    // Some providers signal failure inside a 200 body. Treat status===0 / 'OK'
    // / numeric-success as ok; surface anything else as a soft failure.
    const status = parsed?.status;
    const success =
      status === 0 || status === '0' || status === 'OK' || status === 'ok' || status === undefined; // empty/non-JSON 200 → assume success
    if (!success) {
      const error = parsed?.message ?? `status_${String(status)}`;
      console.warn('[sms:019] failed', { to: masked, status: response.status, error });
      return { ok: false, error };
    }

    const id = parsed?.id !== undefined ? String(parsed.id) : undefined;
    console.info('[sms:019] sent', { to: masked, status: response.status, id });
    return id ? { ok: true, id } : { ok: true };
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 3) return '***';
  return `${phone.slice(0, 3)}***`;
}
