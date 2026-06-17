import {
  isAuthSuccess,
  signAccessToken,
  signRefreshToken,
  STAFF_ROLES,
  verifyRefreshToken,
} from '@memesh/auth';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authConfig } from '../auth.js';
import { env } from '../config.js';
import { requireAuthHook } from '../lib/auth-guards.js';
import { verifyStaffLogin } from '../lib/staff-repo.js';

const ACCESS_MAX_AGE_SEC = 15 * 60;
const REFRESH_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const staffLoginBodySchema = z.object({
  phone: z.string().min(3).max(32),
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

const setAuthCookies = (reply: FastifyReply, accessToken: string, refreshToken: string): void => {
  const isProd = env.NODE_ENV === 'production';
  reply.setCookie('access_token', accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_MAX_AGE_SEC,
  });
  reply.setCookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/auth/refresh',
    maxAge: REFRESH_MAX_AGE_SEC,
  });
};

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Staff login with phone + password/PIN.
  fastify.post('/auth/login', async (request, reply) => {
    const parsed = staffLoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const login = await verifyStaffLogin(parsed.data.phone, parsed.data.password);
    if (!login) {
      request.log.info('[auth login] rejected');
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

  fastify.get('/auth/me', { preHandler: requireAuthHook }, async (request) => {
    return { user: request.user };
  });

  fastify.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie('access_token', { path: '/' });
    reply.clearCookie('refresh_token', { path: '/auth/refresh' });
    return { ok: true };
  });
};
