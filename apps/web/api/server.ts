import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
// The bundle is built by scripts/build-api-bundle.mjs as part of the build
// step. It contains the entire Fastify app with all workspace deps inlined,
// so the Vercel serverless runtime can execute it without trying (and
// failing) to resolve `.ts` source files through workspace symlinks.
// @ts-expect-error - generated at build time
import { buildApp } from '../lib/api-bundle.mjs';

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

// Vercel routes /api/* to this catch-all. Fastify registers routes WITHOUT the
// /api prefix (matching the dev-time Vite proxy in vite.config.ts), so we
// strip the prefix from req.url before handing the request to Fastify.
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.url === '/api') req.url = '/';
  else if (req.url?.startsWith('/api/')) req.url = req.url.slice(4);
  const app = await getApp();
  app.server.emit('request', req, res);
}
