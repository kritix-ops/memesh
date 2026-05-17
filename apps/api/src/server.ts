import cors from '@fastify/cors';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { securityPlugin } from './plugins/security.js';
import { authRoutes } from './routes/auth.js';
import { qrRoutes } from './routes/qr.js';

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
await fastify.register(qrRoutes);

fastify.get('/health', async () => ({
  status: 'ok',
  env: env.NODE_ENV,
  timestamp: new Date().toISOString(),
}));

const start = async (): Promise<void> => {
  try {
    await fastify.listen({ port: env.PORT, host: '0.0.0.0' });
    fastify.log.info({ port: env.PORT, env: env.NODE_ENV }, '[api boot] server started');
  } catch (err) {
    fastify.log.fatal({ err }, '[api boot] server failed to start');
    process.exit(1);
  }
};

void start();
