import { signCustomerToken } from '@memesh/auth';
import {
  db,
  getCardSettings,
  renderEmailOtpBody,
  requestEmailOtp,
  requestOtp,
  verifyEmailOtp,
  verifyOtp,
} from '@memesh/db';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { customerAuthConfig } from '../auth.js';
import { env } from '../config.js';
import { clearCookieScope, cookieScope } from '../lib/cookie-scope.js';
import { emailProvider } from '../lib/email.js';
import { phoneSchema } from '../lib/phone-schema.js';
import { smsProvider } from '../lib/sms.js';

const CUSTOMER_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const requestSchema = z.object({ phone: phoneSchema });
const verifySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{4,8}$/),
});

const emailRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
});
const emailVerifySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  code: z.string().regex(/^\d{4,8}$/),
});

const setCustomerCookie = (reply: FastifyReply, token: string): void => {
  // cookieScope() handles HttpOnly, Secure, SameSite, Path, and the optional
  // Domain attribute. We only need to add the customer-specific max-age here.
  reply.setCookie('customer_token', token, {
    ...cookieScope(),
    maxAge: CUSTOMER_SESSION_MAX_AGE_SEC,
  });
};

export const customerAuthRoutes: FastifyPluginAsync = async (fastify) => {
  // Step 1: request a one-time code. Always responds the same so the endpoint
  // never reveals whether the phone belongs to a customer or was throttled.
  fastify.post(
    '/auth/customer/request-otp',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await requestOtp(db, parsed.data.phone, { pepper: env.SERVER_SECRET_KEY });
      if (result.sent) {
        // Check the provider result so a "200 OK but status:Error" body (the
        // documented Pulseem failure shape) is not silently swallowed. The
        // customer is waiting on a code that the route otherwise pretends was
        // sent. Asymmetric with cards.ts post-sale path before this fix.
        const res = await smsProvider.send({
          to: parsed.data.phone,
          body: `קוד הכניסה שלך לממש: ${result.code}`,
        });
        if (res.ok) {
          request.log.info(
            { providerId: res.id ?? null },
            '[otp request] sms sent',
          );
        } else {
          // The OTP row was already written; it will expire on its own. The
          // outer response stays { ok: true } so the route still does not
          // reveal whether the phone is on file — but the operator can grep
          // this log when a customer reports "I never got my code".
          request.log.warn(
            { error: res.error },
            '[otp request] sms provider error AFTER row insert',
          );
        }
      } else {
        request.log.info({ reason: result.reason }, '[otp request] not sent');
      }
      return { ok: true };
    },
  );

  // Step 2: verify the code and start a customer session.
  //
  // Error surfacing: we surface `code_locked` and `code_expired` distinctly so
  // the SPA can show a real recovery message (and the resend button) instead
  // of the catch-all "wrong code, ask for a new one" — which left customers
  // stuck for 15 min with no clue. The narrow enumeration oracle this opens
  // (an attacker who guesses a customer's phone could probe whether it's in
  // a "locked" state) is acceptable in exchange for unblocking the legitimate
  // customer at the desk. Bad-code paths still collapse to `invalid_code`.
  fastify.post(
    '/auth/customer/verify-otp',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await verifyOtp(db, parsed.data.phone, parsed.data.code, {
        pepper: env.SERVER_SECRET_KEY,
      });
      if (!result.ok) {
        request.log.info({ reason: result.reason }, '[otp verify] rejected');
        if (result.reason === 'locked') {
          return reply.code(401).send({ ok: false, error: 'code_locked' });
        }
        if (result.reason === 'expired') {
          return reply.code(401).send({ ok: false, error: 'code_expired' });
        }
        return reply.code(401).send({ ok: false, error: 'invalid_code' });
      }
      const token = await signCustomerToken(result.customerId, customerAuthConfig);
      setCustomerCookie(reply, token);
      return { ok: true, token };
    },
  );

  // Email-OTP fallback when SMS fails. Same opaque-response shape as the SMS
  // path — the route never reveals whether the email is on file. Only sends
  // when customers.email matches exactly.
  fastify.post(
    '/auth/customer/request-email-otp',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = emailRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await requestEmailOtp(db, parsed.data.email, {
        pepper: env.SERVER_SECRET_KEY,
      });
      if (result.sent) {
        const settings = await getCardSettings(db);
        const text = renderEmailOtpBody(settings.emailOtpBodyTemplate, {
          firstName: result.firstName,
          code: result.code,
        });
        const sendResult = await emailProvider.send({
          to: parsed.data.email,
          subject: settings.emailOtpSubject,
          text,
        });
        if (!sendResult.ok) {
          // Provider failed AFTER we wrote the OTP row. The code is unusable
          // (customer never received it) but the row will expire on its own
          // in 10 min. Log and return the same opaque ok:true so the route
          // doesn't leak the existence of the email via timing-sensitive errors.
          request.log.warn(
            { error: sendResult.error },
            '[email otp request] provider failed AFTER row insert',
          );
        } else {
          request.log.info(
            { providerId: sendResult.id },
            '[email otp request] sent',
          );
        }
      } else {
        request.log.info({ reason: result.reason }, '[email otp request] not sent');
      }
      return { ok: true };
    },
  );

  // Verify the email-OTP and start a customer session — identical cookie
  // semantics to the SMS flow so the rest of the customer area can stay
  // agnostic to which channel was used.
  fastify.post(
    '/auth/customer/verify-email-otp',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = emailVerifySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await verifyEmailOtp(db, parsed.data.email, parsed.data.code, {
        pepper: env.SERVER_SECRET_KEY,
      });
      if (!result.ok) {
        request.log.info({ reason: result.reason }, '[email otp verify] rejected');
        if (result.reason === 'locked') {
          return reply.code(401).send({ ok: false, error: 'code_locked' });
        }
        if (result.reason === 'expired') {
          return reply.code(401).send({ ok: false, error: 'code_expired' });
        }
        return reply.code(401).send({ ok: false, error: 'invalid_code' });
      }
      const token = await signCustomerToken(result.customerId, customerAuthConfig);
      setCustomerCookie(reply, token);
      return { ok: true, token };
    },
  );

  // Logout. Clears the customer session cookie. Safe to call when not signed
  // in (idempotent). The HttpOnly cookie can only be cleared by the server,
  // so this endpoint exists specifically to let the customer truly sign out
  // before the 7-day cookie expires.
  fastify.post('/auth/customer/logout', async (_request, reply) => {
    reply.clearCookie('customer_token', clearCookieScope());
    return { ok: true };
  });
};
