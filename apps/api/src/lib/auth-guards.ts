import type { UserRole } from '@memesh/auth';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

export const requireAuthHook: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  if (!request.user) {
    request.log.info({ path: request.url }, '[api auth] unauthorized');
    return reply.code(401).send({ error: 'unauthorized' });
  }
};

export const requireRoleHook = (...roles: UserRole[]): preHandlerHookHandler =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      request.log.info({ path: request.url }, '[api auth] unauthorized');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!roles.includes(request.user.role)) {
      request.log.info(
        { path: request.url, role: request.user.role, allowed: roles },
        '[api auth] forbidden',
      );
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
