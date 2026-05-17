import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';

export const securityPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  });

  await fastify.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  fastify.log.info('[api security] helmet + rate-limit registered');
};
