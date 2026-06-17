import { cancelCard, createPunchCard, db } from '@memesh/db';
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

const cancelBodySchema = z.object({ reason: z.string().min(1).max(500) });

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

  // Cancel a card (manager/admin), with a required reason. Logged to the action log.
  fastify.post(
    '/cards/:id/cancel',
    { preHandler: requireRoleHook('manager', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const parsed = cancelBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const cancelled = await cancelCard(db, {
        cardId: id,
        reason: parsed.data.reason,
        ...(request.user ? { staffId: request.user.id } : {}),
      });
      if (!cancelled) return reply.code(404).send({ error: 'not_found' });
      request.log.info({ cardId: id }, '[cards] cancelled');
      return reply.send({ card: cancelled });
    },
  );
};
