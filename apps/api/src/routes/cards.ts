import { createPunchCard, db } from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';

const STAFF = ['cashier', 'manager', 'admin'] as const;

const createBodySchema = z.object({
  customerId: z.string().uuid(),
  totalEntries: z.number().int().positive().max(100).optional(),
  source: z.enum(['pos', 'online', 'manual']).optional(),
});

export const cardsRoutes: FastifyPluginAsync = async (fastify) => {
  // Sell a punch card. Payment is taken externally (AccuPOS); staff confirm here,
  // then the server allocates a serial, mints the signed QR, and stores the card.
  fastify.post('/cards', { preHandler: requireRoleHook(...STAFF) }, async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const card = await createPunchCard(db, envKeyResolver, {
      customerId: parsed.data.customerId,
      ...(parsed.data.totalEntries !== undefined && { totalEntries: parsed.data.totalEntries }),
      ...(parsed.data.source !== undefined && { source: parsed.data.source }),
    });
    request.log.info({ cardId: card.id, serial: card.serialNumber }, '[cards] created');
    return reply.code(201).send({ card });
  });
};
