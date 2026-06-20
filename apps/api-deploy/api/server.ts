import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
// The bundle is built by scripts/build-api-bundle.mjs as part of the Vercel
// build step. It contains the entire Fastify app with all workspace deps
// inlined so the serverless runtime can execute it without trying (and
// failing) to resolve `.ts` source files through workspace symlinks.
// This file is the canonical API deploy for api.memesh.co.il — the twin
// wrapper at apps/web/api/server.ts goes away once Phase 5 deletes apps/web.
// @ts-expect-error - generated at build time
import { buildApp } from '../lib/api-bundle.mjs';

let appPromise: Promise<FastifyInstance> | null = null;

const getApp = (): Promise<FastifyInstance> => {
  if (!appPromise) {
    appPromise = (async () => {
      const app = await buildApp();
      await app.ready();
      app.log.info('[api canonical-deploy boot] ready');
      return app;
    })();
  }
  return appPromise;
};

// On api.memesh.co.il the frontend calls e.g. /auth/login (no /api prefix
// because VITE_API_URL is set to the bare origin). The /api → strip is
// retained for backward compat in case Vercel routes /api/* through this
// function during a transitional deploy.
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.url === '/api') req.url = '/';
  else if (req.url?.startsWith('/api/')) req.url = req.url.slice(4);
  const app = await getApp();
  app.server.emit('request', req, res);
}
