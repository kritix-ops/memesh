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
import { meRoutes } from './routes/me.js';
import { punchRoutes } from './routes/punch.js';
import { reportsRoutes } from './routes/reports.js';
import { staffRoutes } from './routes/staff.js';
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

  await fastify.register(cors, {
    origin: env.NODE_ENV === 'development' ? true : false,
    credentials: true,
  });

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
  await fastify.register(authPlugin);
  await fastify.register(authRoutes);
  await fastify.register(customerAuthRoutes);
  await fastify.register(meRoutes);
  await fastify.register(customersRoutes);
  await fastify.register(cardsRoutes);
  await fastify.register(cardSettingsRoutes);
  await fastify.register(punchRoutes);
  await fastify.register(staffRoutes);
  await fastify.register(adminRoutes);
  await fastify.register(reportsRoutes);
  await fastify.register(webhooksWcRoutes);

  fastify.get('/health', async () => ({
    status: 'ok',
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  }));

  return fastify;
};
