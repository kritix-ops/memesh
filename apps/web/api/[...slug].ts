import { buildApp } from '@memesh/api/app';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Cache the Fastify instance across warm invocations of this serverless
// function. Cold starts pay the build cost once; subsequent requests reuse it.
let appPromise: Promise<FastifyInstance> | null = null;

const getApp = (): Promise<FastifyInstance> => {
  if (!appPromise) {
    appPromise = (async () => {
      const app = await buildApp();
      await app.ready();
      return app;
    })();
  }
  return appPromise;
};

// Vercel routes /api/* to this catch-all function. The Fastify app inside
// registers routes WITHOUT the /api prefix (so /api/auth/login is /auth/login
// inside Fastify), matching the dev-time Vite proxy behavior in vite.config.ts.
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.url === '/api') req.url = '/';
  else if (req.url?.startsWith('/api/')) req.url = req.url.slice(4);
  const app = await getApp();
  app.server.emit('request', req, res);
}
