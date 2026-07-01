import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { securityPlugin } from './plugins/security.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { cardSettingsRoutes } from './routes/card-settings.js';
import { cardsRoutes } from './routes/cards.js';
import { customerAuthRoutes } from './routes/customer-auth.js';
import { customersRoutes } from './routes/customers.js';
import { debugQrRoutes } from './routes/debug-qr.js';
import { giftClaimRoutes } from './routes/gift-claim.js';
import { meRoutes } from './routes/me.js';
import { punchRoutes } from './routes/punch.js';
import { cronGiftExpireRoutes } from './routes/cron-gift-expire.js';
import { cronRoundsHoldSweepRoutes } from './routes/cron-rounds-hold-sweep.js';
import { cronWcReconcileRoutes } from './routes/cron-wc-reconcile.js';
import { reportsRoutes } from './routes/reports.js';
import { rolePermissionsRoutes } from './routes/role-permissions.js';
import { roundsAdminRoutes } from './routes/rounds-admin.js';
import { roundsBookingRoutes } from './routes/rounds-booking.js';
import { staffRoutes } from './routes/staff.js';
import { staffPinRoutes } from './routes/staff-pin.js';
import { staffRoundsRoutes } from './routes/staff-rounds.js';
import { wcHandoffRoutes } from './routes/wc-handoff.js';
import { webhooksWcRoutes } from './routes/webhooks-wc.js';

/** Build the Fastify app without listening, so it can be driven by tests via inject(). */
export const buildApp = async (): Promise<FastifyInstance> => {
  const fastify = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty' } }
        : { level: env.LOG_LEVEL },
    trustProxy: true,
    genReqId: () => randomUUID(),
  });

  // CORS topology:
  //   - dev: `origin: true` so localhost frontends (and any *.localtest.me
  //     hostname mapped via /etc/hosts for the split-subdomain SSO test) work.
  //   - prod with CORS_ALLOWED_ORIGINS set: explicit allowlist for the
  //     split-subdomain topology — exactly staff./admin./my.memesh.co.il,
  //     credentials:true so the browser sends HttpOnly cookies on the
  //     cross-subdomain hop to api.memesh.co.il.
  //   - prod without CORS_ALLOWED_ORIGINS: same-origin deploy (apps/web today),
  //     so cross-origin requests are rejected. Wildcard origin is never used —
  //     the fetch spec forbids it with credentials:true anyway.
  const allowList = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  await fastify.register(cors, {
    origin:
      env.NODE_ENV === 'development'
        ? true
        : allowList.length > 0
          ? allowList
          : false,
    credentials: true,
  });
  if (env.NODE_ENV === 'production' && allowList.length > 0) {
    fastify.log.info({ allowList }, '[api cors] allowlist active');
  }

  // Register @fastify/cookie at the root level so reply.setCookie and
  // request.cookies are available across every route, regardless of which
  // sub-plugin registers a child later. Was previously nested inside
  // authPlugin, which worked in dev (tsx loads a single Fastify instance) but
  // broke under esbuild bundling for Vercel — the fastify-plugin "skip
  // encapsulation" marker symbol got duplicated across module copies and the
  // decoration stopped propagating, so reply.setCookie was undefined inside
  // /auth/login.
  await fastify.register(cookie);

  await fastify.register(securityPlugin);

  // The API surface is never meant to be indexed by a search engine. The
  // per-frontend `<meta>` and robots.txt cover HTML, but the only mechanism
  // that protects non-HTML responses (everything Fastify returns) is the
  // X-Robots-Tag header. Registered at the root level — NOT inside
  // securityPlugin — because Fastify plugins encapsulate their hooks by
  // default and routes registered at the root scope would otherwise miss it.
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return payload;
  });

  await fastify.register(authPlugin);
  await fastify.register(authRoutes);
  await fastify.register(customerAuthRoutes);
  await fastify.register(giftClaimRoutes);
  await fastify.register(wcHandoffRoutes);
  await fastify.register(meRoutes);
  await fastify.register(customersRoutes);
  await fastify.register(cardsRoutes);
  await fastify.register(cardSettingsRoutes);
  await fastify.register(punchRoutes);
  await fastify.register(debugQrRoutes);
  await fastify.register(staffRoutes);
  await fastify.register(staffPinRoutes);
  await fastify.register(staffRoundsRoutes);
  await fastify.register(rolePermissionsRoutes);
  await fastify.register(roundsAdminRoutes);
  await fastify.register(roundsBookingRoutes);
  await fastify.register(adminRoutes);
  await fastify.register(reportsRoutes);
  await fastify.register(webhooksWcRoutes);
  await fastify.register(cronWcReconcileRoutes);
  await fastify.register(cronGiftExpireRoutes);
  await fastify.register(cronRoundsHoldSweepRoutes);

  fastify.get('/health', async () => ({
    status: 'ok',
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  }));

  return fastify;
};

/**
 * Parse CORS_ALLOWED_ORIGINS into a normalized origin array. Whitespace and
 * empty entries are dropped; the surrounding plugin treats an empty result
 * as "no allowlist configured".
 */
const parseAllowedOrigins = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};
