import {
  ConsoleEmailProvider,
  PulseemEmailProvider,
  ResendProvider,
  type EmailProvider,
} from '@memesh/email';
import { env } from '../config.js';

/**
 * Select the email provider based on env. Three options:
 *
 *   - 'console' (default) — logs each message to stdout. Safe for dev and
 *     for the first production boot before any live provider is wired.
 *   - 'resend' — used initially for the customer email-OTP fallback.
 *     Resend's free tier covers 3,000 emails/month with a 100/day cap.
 *   - 'pulseem' — the post-purchase email cutover (2026-06-23). Reuses
 *     the same Pulseem account that already sends SMS, so all
 *     customer-facing notifications land under one vendor and one invoice.
 *     See _plans/2026-06-23-post-purchase-email.md.
 */
function createEmailProvider(): EmailProvider {
  if (env.EMAIL_PROVIDER === 'pulseem') {
    if (!env.PULSEEM_API_KEY || !env.PULSEEM_EMAIL_FROM_EMAIL || !env.PULSEEM_EMAIL_FROM_NAME) {
      throw new Error(
        '[api email] EMAIL_PROVIDER=pulseem requires PULSEEM_API_KEY, PULSEEM_EMAIL_FROM_EMAIL, and PULSEEM_EMAIL_FROM_NAME',
      );
    }
    return new PulseemEmailProvider({
      apiKey: env.PULSEEM_API_KEY,
      fromEmail: env.PULSEEM_EMAIL_FROM_EMAIL,
      fromName: env.PULSEEM_EMAIL_FROM_NAME,
      ...(env.PULSEEM_BASE_URL !== undefined && { baseUrl: env.PULSEEM_BASE_URL }),
    });
  }
  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
      throw new Error(
        '[api email] EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM',
      );
    }
    return new ResendProvider({
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
    });
  }
  return new ConsoleEmailProvider();
}

export const emailProvider: EmailProvider = createEmailProvider();
