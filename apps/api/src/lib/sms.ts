import {
  ConsoleSmsProvider,
  PulseemProvider,
  Sms019Provider,
  type SmsProvider,
} from '@memesh/sms';
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
