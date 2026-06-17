import cookie from '@fastify/cookie';
import { isAuthSuccess, verifyAccessToken } from '@memesh/auth';
import type { StaffRole } from '@memesh/auth';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authConfig } from '../auth.js';

export interface RequestUser {
  id: string;
  role: StaffRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: RequestUser | null;
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

export const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(cookie);

  fastify.decorateRequest('user', null);

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
