import {
  ConsoleSmsProvider,
  PulseemProvider,
  Sms019Provider,
  type SmsProvider,
} from '@memesh/sms';
import { getCardSettings, isQuietHourNow, type CardSettingsRow } from '@memesh/db';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '@memesh/db';
import { env } from '../config.js';

/**
 * Select the SMS provider based on env. 'console' is the safe default and
 * logs each message to stdout (used in dev and on a fresh production deploy
 * before SMS credentials are wired). 'pulseem' is the live provider Yanai
 * signed up for at pulseem.co.il — requires PULSEEM_API_KEY and
 * PULSEEM_FROM_NUMBER. '019' is a DRAFT alternative that was never used
 * against a real account; kept for now but not recommended.
 *
 * See _plans/2026-06-19-pulseem-sms-provider.md for the integration plan.
 */
function createSmsProvider(): SmsProvider {
  if (env.SMS_PROVIDER === 'pulseem') {
    if (!env.PULSEEM_API_KEY || !env.PULSEEM_FROM_NUMBER) {
      throw new Error(
        '[api sms] SMS_PROVIDER=pulseem requires PULSEEM_API_KEY and PULSEEM_FROM_NUMBER',
      );
    }
    return new PulseemProvider({
      apiKey: env.PULSEEM_API_KEY,
      fromNumber: env.PULSEEM_FROM_NUMBER,
      ...(env.PULSEEM_BASE_URL !== undefined && { baseUrl: env.PULSEEM_BASE_URL }),
    });
  }
  if (env.SMS_PROVIDER === '019') {
    if (!env.SMS_019_TOKEN || !env.SMS_019_SOURCE) {
      throw new Error('[api sms] SMS_PROVIDER=019 requires SMS_019_TOKEN and SMS_019_SOURCE');
    }
    return new Sms019Provider({
      token: env.SMS_019_TOKEN,
      source: env.SMS_019_SOURCE,
      ...(env.SMS_019_ENDPOINT !== undefined && { endpoint: env.SMS_019_ENDPOINT }),
    });
  }
  return new ConsoleSmsProvider();
}

export const smsProvider: SmsProvider = createSmsProvider();

// ---------------------------------------------------------------------------
// Marketing SMS wrapper — respects customer consent + admin quiet hours.
// Transactional sends (OTP) call `smsProvider.send()` directly to bypass these
// gates: a user who just clicked "send code" expects the code immediately.
// ---------------------------------------------------------------------------

export type MarketingSmsKind = 'purchase' | 'low_entries';

export interface MarketingSmsInput {
  to: string;
  body: string;
  /** Pass the customer's `marketingConsentAt` straight through. Null = no consent. */
  marketingConsentAt: Date | string | null;
  /** Used by the per-kind enable flag inside settings. */
  kind: MarketingSmsKind;
  /** Optional logger so call sites can keep their request id correlation. */
  log?: FastifyBaseLogger;
  /** Optional pre-loaded settings to avoid a second roundtrip. */
  settings?: CardSettingsRow;
  /** Injectable clock for tests. */
  now?: Date;
}

export type MarketingSmsResult =
  | { sent: true; id?: string }
  | { sent: false; reason: 'no_consent' | 'disabled' | 'quiet_hours' | 'provider_error' };

/**
 * Try to send a marketing SMS. Never throws; failures are returned as a
 * `sent: false` result with a reason. Call sites should fire-and-log — a
 * failed marketing SMS must not fail the underlying business operation
 * (purchase, punch, etc.).
 */
export async function sendMarketingSms(input: MarketingSmsInput): Promise<MarketingSmsResult> {
  const settings = input.settings ?? (await getCardSettings(db));
  const now = input.now ?? new Date();

  // Per-kind enable flag.
  if (input.kind === 'purchase' && !settings.smsOnPurchase) {
    input.log?.info({ kind: input.kind }, '[sms marketing] disabled by setting');
    return { sent: false, reason: 'disabled' };
  }
  if (input.kind === 'low_entries' && settings.smsLowEntriesThreshold <= 0) {
    input.log?.info({ kind: input.kind }, '[sms marketing] disabled by setting');
    return { sent: false, reason: 'disabled' };
  }

  // Legal gate: never send marketing without consent.
  if (!input.marketingConsentAt) {
    input.log?.info({ kind: input.kind }, '[sms marketing] skipped: no consent');
    return { sent: false, reason: 'no_consent' };
  }

  // Quiet hours (Asia/Jerusalem). Currently drops the send — no queue yet.
  // When the cron infra lands, this branch should enqueue for the next allowed
  // minute instead of dropping.
  if (isQuietHourNow(settings.smsQuietStartMinutes, settings.smsQuietEndMinutes, now)) {
    input.log?.info({ kind: input.kind }, '[sms marketing] skipped: quiet hours');
    return { sent: false, reason: 'quiet_hours' };
  }

  try {
    const res = await smsProvider.send({ to: input.to, body: input.body });
    if (!res.ok) {
      input.log?.warn({ kind: input.kind, error: res.error }, '[sms marketing] provider error');
      return { sent: false, reason: 'provider_error' };
    }
    input.log?.info({ kind: input.kind, id: res.id }, '[sms marketing] sent');
    return res.id ? { sent: true, id: res.id } : { sent: true };
  } catch (err) {
    input.log?.error({ err, kind: input.kind }, '[sms marketing] threw');
    return { sent: false, reason: 'provider_error' };
  }
}
