import { isAuthSuccess, verifyAccessToken } from '@memesh/auth';
import type { StaffRole } from '@memesh/auth';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { authConfig } from '../auth.js';

export interface RequestUser {
  id: string;
  role: StaffRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: RequestUser | null;
    customer: { id: string } | null;
  }
}

const extractToken = (req: FastifyRequest): string | undefined => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const fromCookie = req.cookies?.access_token;
  return fromCookie;
};

const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  // @fastify/cookie is registered at the root in app.ts so reply.setCookie
  // is available everywhere; we only attach request decorators here.
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('customer', null);

  fastify.addHook('onRequest', async (request) => {
    const token = extractToken(request);
    if (!token) {
      request.user = null;
      return;
    }
    const result = await verifyAccessToken(token, authConfig);
    if (isAuthSuccess(result)) {
      request.user = { id: result.claims.sub, role: result.claims.role };
    } else {
      request.user = null;
      request.log.debug({ error: result.error }, '[api auth] token verify failed');
    }
  });

  fastify.log.info('[api auth] auth plugin registered');
};

// fastify-plugin lifts the decorators and the onRequest hook out of this
// plugin's encapsulation context so they apply to sibling plugins (the route
// modules) too. Without fp, the bundled deploy left request.user undefined
// inside the route handlers — every /auth/me, /punch, etc. returned 401 even
// when the caller had a valid token, because the hook never ran for them.
export const authPlugin = fp(authPluginImpl, { name: 'memesh-auth' });
