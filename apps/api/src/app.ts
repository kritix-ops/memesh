import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { securityPlugin } from './plugins/security.js';
import { authRoutes } from './routes/auth.js';
import { cardsRoutes } from './routes/cards.js';
import { customerAuthRoutes } from './routes/customer-auth.js';
import { customersRoutes } from './routes/customers.js';
import { meRoutes } from './routes/me.js';
import { punchRoutes } from './routes/punch.js';

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

  await fastify.register(securityPlugin);
  await fastify.register(authPlugin);
  await fastify.register(authRoutes);
  await fastify.register(customerAuthRoutes);
  await fastify.register(meRoutes);
  await fastify.register(customersRoutes);
  await fastify.register(cardsRoutes);
  await fastify.register(punchRoutes);

  fastify.get('/health', async () => ({
    status: 'ok',
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  }));

  return fastify;
};
