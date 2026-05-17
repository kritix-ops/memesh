import cors from '@fastify/cors';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { securityPlugin } from './plugins/security.js';
import { authRoutes } from './routes/auth.js';
import { qrRoutes } from './routes/qr.js';
import { wcWebhookRoutes } from './routes/wc-webhook.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

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

// Capture raw body for HMAC verification on inbound webhooks while still
// providing parsed JSON to handlers. Applies to all application/json requests.
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (request, body: Buffer, done) => {
    request.rawBody = body;
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

await fastify.register(securityPlugin);
await fastify.register(authPlugin);
await fastify.register(authRoutes);
await fastify.register(qrRoutes);
await fastify.register(wcWebhookRoutes);

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
