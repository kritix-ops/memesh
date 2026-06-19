import {
  cancelCard,
  cardDetail,
  createPunchCard,
  db,
  getCardSettings,
  getCustomerById,
  listCards,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';
import { sendMarketingSms } from '../lib/sms.js';

const STAFF = ['cashier', 'manager', 'admin'] as const;

const createBodySchema = z.object({
  customerId: z.string().uuid(),
  totalEntries: z.number().int().positive().max(100).optional(),
  source: z.enum(['pos', 'online', 'manual']).optional(),
});

const cancelBodySchema = z.object({ reason: z.string().min(1).max(500) });

const listQuerySchema = z.object({
  status: z.enum(['active', 'expired', 'cancelled']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
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

    // Fire-and-log marketing SMS after the sale. The wrapper enforces the
    // smsOnPurchase setting, customer consent, and quiet hours. Failures
    // never bubble up — the sale must not fail because SMS failed.
    void (async () => {
      try {
        const customer = await getCustomerById(db, parsed.data.customerId);
        if (!customer) return;
        await sendMarketingSms({
          to: customer.phone,
          body: `הכרטיסייה שלך ב-Memesh נוצרה! ${card.totalEntries} כניסות, תוקף עד ${card.expiresAt.toISOString().slice(0, 10)}. מספר סידורי: ${card.serialNumber}`,
          marketingConsentAt: customer.marketingConsentAt,
          kind: 'purchase',
          log: request.log,
        });
      } catch (err) {
        request.log.warn({ err }, '[cards] post-sale SMS failed silently');
      }
    })();

    return reply.code(201).send({ card });
  });

  // List cards joined with customer info, filtered by status. Read-only admin
  // surface; cashiers see cards via the per-customer detail screen.
  fastify.get(
    '/cards',
    { preHandler: requireRoleHook('admin', 'manager') },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      const cards = await listCards(db, parsed.data);
      return { cards };
    },
  );

  // Card detail for the admin drill-down view: card + customer + full entry
  // history with the punching staff's name. admin or manager only.
  fastify.get(
    '/cards/:id',
    { preHandler: requireRoleHook('admin', 'manager') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const detail = await cardDetail(db, id);
      if (!detail) return reply.code(404).send({ error: 'not_found' });
      return detail;
    },
  );

  // Cancel a card, with a required reason. Logged to the action log.
  // Role gate is settings-driven (`cancelRole`): 'admin' = admin only,
  // 'manager' = admin + manager (default). We enforce auth + role manually
  // here because the allowed roles depend on the live setting.
  fastify.post('/cards/:id/cancel', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthorized' });

    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const parsed = cancelBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const settings = await getCardSettings(db);
    const allowed: ReadonlyArray<'admin' | 'manager'> =
      settings.cancelRole === 'admin' ? ['admin'] : ['admin', 'manager'];
    if (!allowed.includes(request.user.role as 'admin' | 'manager')) {
      request.log.info(
        { role: request.user.role, allowed, cancelRole: settings.cancelRole },
        '[cards cancel] forbidden by settings',
      );
      return reply.code(403).send({ error: 'forbidden' });
    }

    const result = await cancelCard(db, {
      cardId: id,
      reason: parsed.data.reason,
      staffId: request.user.id,
    });
    if (!result.ok) {
      if (result.reason === 'not_found') {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (result.reason === 'cancel_blocked_after_punch') {
        return reply.code(409).send({
          error: 'cancel_blocked_after_punch',
          usedEntries: result.usedEntries,
        });
      }
      if (result.reason === 'reason_too_short') {
        return reply.code(400).send({
          error: 'reason_too_short',
          minLength: result.minLength,
        });
      }
    } else {
      request.log.info({ cardId: id }, '[cards] cancelled');
      return reply.send({ card: result.card });
    }
    // Defensive: every branch above returns.
    return reply.code(500).send({ error: 'unknown' });
  });
};
