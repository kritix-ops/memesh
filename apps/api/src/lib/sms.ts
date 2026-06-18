import { ConsoleSmsProvider, Sms019Provider, type SmsProvider } from '@memesh/sms';
import { env } from '../config.js';

/**
 * Select the SMS provider based on env. Console is the safe default — actual
 * SMS only flips on when SMS_PROVIDER=019 + the SMS_019_* secrets are set.
 *
 * The Sms019Provider is DRAFT (see _plans/2026-06-18-sms-provider-selection.md):
 * its JSON wire format is the best read of the 019 docs we could verify, but
 * the first live call against a real account is what confirms it.
 */
function createSmsProvider(): SmsProvider {
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
