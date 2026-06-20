import { ConsoleEmailProvider, ResendProvider, type EmailProvider } from '@memesh/email';
import { env } from '../config.js';

/**
 * Select the email provider based on env. 'console' (default) logs each
 * message to stdout — fine for dev and for the first production boot before
 * the Resend account is wired. 'resend' is the live provider for the customer
 * email-OTP fallback path.
 *
 * Pricing: Resend's free tier covers 3,000 emails/month with a 100/day cap,
 * which dwarfs the expected OTP-fallback volume. See the cost section in
 * _plans/2026-06-20-seller-attribution-and-email-fallback.md.
 */
function createEmailProvider(): EmailProvider {
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
