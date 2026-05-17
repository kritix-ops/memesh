import { isVerifyFailure, signToken, verifyToken } from '@memesh/qr-engine';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { envKeyResolver } from '../qr.js';

const signBodySchema = z.object({
  ticketId: z.string().uuid(),
  userId: z.string().uuid(),
  serial: z.string().min(1).max(32),
});

const verifyBodySchema = z.object({
  token: z.string().min(1).max(2048),
});

export const qrRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/qr/sign', async (request, reply) => {
    const parsed = signBodySchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.info({ issues: parsed.error.issues }, '[qr sign] invalid body');
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const token = signToken(
      {
        ticketId: parsed.data.ticketId,
        userId: parsed.data.userId,
        createdTs: Math.floor(Date.now() / 1000),
        serial: parsed.data.serial,
      },
      envKeyResolver,
    );
    request.log.info(
      { ticketId: parsed.data.ticketId, serial: parsed.data.serial },
      '[qr sign] signed',
    );
    return { token };
  });

  fastify.post('/qr/verify', async (request, reply) => {
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.info({ issues: parsed.error.issues }, '[qr verify] invalid body');
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const result = verifyToken(parsed.data.token, envKeyResolver);
    if (isVerifyFailure(result)) {
      request.log.info({ error: result.error }, '[qr verify] rejected');
      return reply.code(401).send({ ok: false, error: result.error });
    }
    request.log.info(
      { ticketId: result.payload.ticketId, serial: result.payload.serial },
      '[qr verify] accepted',
    );
    return { ok: true, payload: result.payload };
  });
};
