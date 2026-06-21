import {
  hashPassword,
  isAuthSuccess,
  signAccessToken,
  signRefreshToken,
  STAFF_ROLES,
  verifyRefreshToken,
} from '@memesh/auth';
import {
  consumeStaffPasswordReset,
  countActiveStaffPasswordResets,
  db,
  getStaffById,
  getStaffByEmailWithSecret,
  invalidateStaffPasswordResets,
  mintStaffPasswordReset,
  setStaffPasswordHash,
} from '@memesh/db';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authConfig } from '../auth.js';
import { env } from '../config.js';
import { requireAuthHook } from '../lib/auth-guards.js';
import { clearCookieScope, cookieScope } from '../lib/cookie-scope.js';
import { emailProvider } from '../lib/email.js';
import { verifyStaffLogin } from '../lib/staff-repo.js';

const ACCESS_MAX_AGE_SEC = 15 * 60;
const REFRESH_MAX_AGE_SEC = 7 * 24 * 60 * 60;
const MIN_NEW_PASSWORD_LENGTH = 8;

// Email is the staff login username as of 2026-06-21. We accept whitespace
// and any casing on the wire and normalize to lowercase before lookup; the
// DB has a partial unique index on lower(email) that matches.
const emailField = z.string().trim().toLowerCase().email().max(255);

const staffLoginBodySchema = z.object({
  email: emailField,
  password: z.string().min(1).max(256),
});

const devLoginBodySchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(STAFF_ROLES),
});

const refreshBodySchema = z
  .object({
    refreshToken: z.string().optional(),
  })
  .optional();

const forgotPasswordBodySchema = z.object({
  email: emailField,
});

const resetPasswordBodySchema = z.object({
  // Raw token from the reset URL. base64url, ~43 chars; we accept up to 256
  // to be generous on the wire and let the consume primitive be the judge.
  token: z.string().min(16).max(256),
  newPassword: z.string().min(MIN_NEW_PASSWORD_LENGTH).max(256),
});

const setAuthCookies = (reply: FastifyReply, accessToken: string, refreshToken: string): void => {
  // Both cookies use path '/'. The previous scoping of refresh_token to
  // '/auth/refresh' broke under any /api/* proxy (Vite dev proxy or the
  // production reverse proxy) because the browser stores the cookie at the
  // path the server sent, while the actual refresh request is /api/auth/refresh
  // — paths mismatch, cookie not sent. The cookies are HttpOnly + sameSite=lax
  // (+ Secure in prod), so path scoping never gated a real attack.
  //
  // cookieScope() also adds Domain=.memesh.co.il when COOKIE_DOMAIN is set,
  // so the cookies survive the cross-subdomain hop from staff./admin. to api.
  const scope = cookieScope();
  reply.setCookie('access_token', accessToken, { ...scope, maxAge: ACCESS_MAX_AGE_SEC });
  reply.setCookie('refresh_token', refreshToken, { ...scope, maxAge: REFRESH_MAX_AGE_SEC });
};

/**
 * Build the reset URL the user follows from the email. The URL origin is
 * ALWAYS taken from env.STAFF_LOGIN_URL — never from the request, never from
 * a body field — so a forgot-password call cannot inject an attacker-controlled
 * redirect target. The frontend reads `?reset_token=...` on mount and shows
 * the reset form.
 */
const buildResetUrl = (rawToken: string): string => {
  const base = env.STAFF_LOGIN_URL.replace(/\/+$/, '');
  return `${base}/?reset_token=${encodeURIComponent(rawToken)}`;
};

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Staff login with email + password. Username moved from phone to email on
  // 2026-06-21 so a staff member's credential survives a phone change.
  fastify.post('/auth/login', async (request, reply) => {
    const parsed = staffLoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    request.log.info({ email: parsed.data.email }, '[auth login] attempt');
    const login = await verifyStaffLogin(parsed.data.email, parsed.data.password);
    if (!login) {
      request.log.info({ email: parsed.data.email }, '[auth login] rejected');
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const accessToken = await signAccessToken({ sub: login.id, role: login.role }, authConfig);
    const refreshToken = await signRefreshToken({ sub: login.id, role: login.role }, authConfig);
    setAuthCookies(reply, accessToken, refreshToken);
    request.log.info({ sub: login.id, role: login.role }, '[auth login] issued');
    return { accessToken, refreshToken, role: login.role };
  });

  fastify.post('/auth/dev-login', async (request, reply) => {
    if (env.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const parsed = devLoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const accessToken = await signAccessToken(
      { sub: parsed.data.userId, role: parsed.data.role },
      authConfig,
    );
    const refreshToken = await signRefreshToken(
      { sub: parsed.data.userId, role: parsed.data.role },
      authConfig,
    );
    setAuthCookies(reply, accessToken, refreshToken);
    request.log.info(
      { sub: parsed.data.userId, role: parsed.data.role },
      '[auth dev-login] issued',
    );
    return { accessToken, refreshToken };
  });

  fastify.post('/auth/refresh', async (request, reply) => {
    const fromCookie = request.cookies?.refresh_token;
    const parsed = refreshBodySchema.safeParse(request.body);
    const fromBody = parsed.success ? parsed.data?.refreshToken : undefined;
    const token = fromCookie ?? fromBody;
    if (!token) {
      return reply.code(401).send({ error: 'no_refresh_token' });
    }
    const result = await verifyRefreshToken(token, authConfig);
    if (!isAuthSuccess(result)) {
      request.log.info({ error: result.error }, '[auth refresh] rejected');
      return reply.code(401).send({ error: 'invalid_refresh' });
    }
    const accessToken = await signAccessToken(
      { sub: result.claims.sub, role: result.claims.role },
      authConfig,
    );
    const refreshToken = await signRefreshToken(
      { sub: result.claims.sub, role: result.claims.role },
      authConfig,
    );
    setAuthCookies(reply, accessToken, refreshToken);
    request.log.info({ sub: result.claims.sub }, '[auth refresh] rotated');
    return { accessToken, refreshToken };
  });

  fastify.get('/auth/me', { preHandler: requireAuthHook }, async (request, reply) => {
    // requireAuthHook guarantees request.user is non-null.
    const tokenUser = request.user!;
    const row = await getStaffById(db, tokenUser.id);
    if (!row || !row.isActive) {
      // Token is valid but the staff row is gone or deactivated. The client
      // treats this as signed-out (same as a missing/invalid token).
      request.log.info(
        { sub: tokenUser.id },
        '[auth me] staff row missing or inactive, signing out',
      );
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return {
      user: {
        id: row.id,
        role: row.role,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
      },
    };
  });

  fastify.post('/auth/logout', async (_request, reply) => {
    const clear = clearCookieScope();
    reply.clearCookie('access_token', clear);
    reply.clearCookie('refresh_token', clear);
    return { ok: true };
  });

  // Request a password reset link. Always responds 200 { ok: true } regardless
  // of whether the email is on file — same no-enumeration discipline as the
  // customer OTP routes. When an active staff row with the email and a
  // passwordHash exists, mint a single-use token and email a reset URL.
  //
  // Rate limit:
  //   - fastify rate-limit caps per-IP bursts at 5/min;
  //   - countActiveStaffPasswordResets enforces a per-account cap of 1 active
  //     token, so a flood of requests for one email does not flood the user's
  //     inbox or create token churn.
  fastify.post(
    '/auth/forgot-password',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = forgotPasswordBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const email = parsed.data.email;
      request.log.info({ email }, '[auth forgot] requested');

      const row = await getStaffByEmailWithSecret(db, email);
      if (!row || !row.isActive || !row.passwordHash) {
        request.log.info(
          { email, found: !!row, active: row?.isActive ?? false, hasPassword: !!row?.passwordHash },
          '[auth forgot] skipped (no eligible row)',
        );
        return { ok: true };
      }

      const active = await countActiveStaffPasswordResets(db, row.id);
      if (active >= 1) {
        // A fresh token is still valid; reuse the existing window instead of
        // minting another. The user got an email a moment ago — telling them
        // to check it is better than racing two tokens through their inbox.
        request.log.info(
          { sub: row.id, activeCount: active },
          '[auth forgot] skipped (active token exists)',
        );
        return { ok: true };
      }

      const { raw, expiresAt } = await mintStaffPasswordReset(db, { staffId: row.id });
      const resetUrl = buildResetUrl(raw);
      const subject = 'איפוס סיסמה למערכת ממש';
      const text =
        `שלום ${row.firstName},\n\n` +
        `קיבלנו בקשה לאיפוס הסיסמה לחשבון שלך במערכת הניהול של ממש.\n` +
        `כדי להגדיר סיסמה חדשה, לחצו על הקישור הבא (תקף ל-30 דקות):\n\n` +
        `${resetUrl}\n\n` +
        `אם לא ביקשתם איפוס סיסמה, אפשר להתעלם מההודעה הזו — הסיסמה הקיימת תישאר בתוקף.\n`;
      const send = await emailProvider.send({ to: row.email!, subject, text });
      if (!send.ok) {
        // Token row already inserted; it'll expire on its own. Log and keep
        // the opaque response so the route doesn't leak provider errors as
        // a side channel.
        request.log.warn(
          { sub: row.id, error: send.error },
          '[auth forgot] provider failed AFTER token insert',
        );
      } else {
        request.log.info(
          { sub: row.id, providerId: send.id, expiresAt: expiresAt.toISOString() },
          '[auth forgot] sent',
        );
      }
      return { ok: true };
    },
  );

  // Consume a reset token and rotate the password. On success ALL outstanding
  // reset tokens for the user are burned so a leaked-but-unused token can't
  // be reused. We deliberately do NOT auto-sign-in: the user already has the
  // new password they just set, and the next /auth/login keeps the session
  // model uniform.
  fastify.post(
    '/auth/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = resetPasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const result = await consumeStaffPasswordReset(db, parsed.data.token);
      if (!result.ok) {
        request.log.info({ reason: result.reason }, '[auth reset] rejected');
        return reply.code(400).send({ error: 'invalid_token' });
      }

      // Defense in depth: re-fetch the staff row to confirm it's still active
      // before we accept the new password.
      const row = await getStaffById(db, result.staffId);
      if (!row || !row.isActive) {
        request.log.info(
          { sub: result.staffId, found: !!row },
          '[auth reset] staff row missing or inactive after consume',
        );
        return reply.code(400).send({ error: 'invalid_token' });
      }

      const passwordHash = await hashPassword(parsed.data.newPassword);
      await setStaffPasswordHash(db, result.staffId, passwordHash);
      const { invalidated } = await invalidateStaffPasswordResets(db, result.staffId);
      request.log.info(
        { sub: result.staffId, otherTokensBurned: invalidated },
        '[auth reset] success',
      );
      return { ok: true };
    },
  );
};
