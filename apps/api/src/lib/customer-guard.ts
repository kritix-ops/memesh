import { isAuthSuccess, verifyCustomerToken } from '@memesh/auth';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { customerAuthConfig } from '../auth.js';

const extractToken = (req: FastifyRequest): string | undefined => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return req.cookies?.customer_token;
};

// Gate for customer-area routes. Verifies a customer-audience token (never a
// staff token) and attaches the customer id to the request.
export const requireCustomer: preHandlerHookHandler = async (request, reply) => {
  const token = extractToken(request);
  if (!token) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const result = await verifyCustomerToken(token, customerAuthConfig);
  if (!isAuthSuccess(result)) {
    request.log.debug({ error: result.error }, '[customer auth] token verify failed');
    return reply.code(401).send({ error: 'unauthorized' });
  }
  request.customer = { id: result.claims.sub };
};
