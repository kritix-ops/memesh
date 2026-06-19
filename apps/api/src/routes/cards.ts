import {
  cancelCard,
  cardDetail,
  createPunchCard,
  db,
  getCardSettings,
  getCustomerById,
  listCards,
  reassignCard,
  refundEntry,
  staff,
} from '@memesh/db';
import { verifyPassword } from '@memesh/auth';
import { and, eq, isNotNull } from 'drizzle-orm';
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

const refundBodySchema = z.object({
  reason: z.string().min(1).max(500),
  /** Required when the initiating user's role is not admin. */
  adminPassword: z.string().min(1).max(200).optional(),
});

// Admin-only card creation: same fields as POST /cards plus a validityDays
// override. `null` and `0` both mean "forever". Omit to use settings.
const adminCreateBodySchema = z.object({
  customerId: z.string().uuid(),
  totalEntries: z.number().int().positive().max(100).optional(),
  validityDays: z.number().int().min(0).max(3650).nullable().optional(),
  source: z.enum(['pos', 'online', 'manual']).optional(),
});

const reassignBodySchema = z.object({ customerId: z.string().uuid() });

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
        const expiryClause = card.expiresAt
          ? `, תוקף עד ${card.expiresAt.toISOString().slice(0, 10)}`
          : ' (ללא תפוגה)';
        await sendMarketingSms({
          to: customer.phone,
          body: `הכרטיסייה שלך ב-Memesh נוצרה! ${card.totalEntries} כניסות${expiryClause}. מספר סידורי: ${card.serialNumber}`,
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

  // Refund a single punched entry.
  // - Any signed-in staff (cashier+) may INITIATE the refund.
  // - Admins acting alone authorize themselves (no extra password prompt).
  // - Cashier/manager MUST supply a current admin user's password — server
  //   bcrypt-compares it against every active admin and records that admin
  //   as approvedBy. Mismatch → 403 admin_password_invalid.
  fastify.post(
    '/cards/:cardId/entries/:entryId/refund',
    { preHandler: requireRoleHook(...STAFF) },
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: 'unauthorized' });
      const { cardId, entryId } = request.params as { cardId: string; entryId: string };
      if (!z.string().uuid().safeParse(cardId).success || !z.string().uuid().safeParse(entryId).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const parsed = refundBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      // Resolve approvedBy. Admins approve themselves; cashier/manager need a
      // matching admin password.
      let approvedBy: string;
      if (request.user.role === 'admin') {
        approvedBy = request.user.id;
      } else {
        if (!parsed.data.adminPassword) {
          return reply.code(400).send({ error: 'admin_password_required' });
        }
        const admins = await db
          .select({ id: staff.id, passwordHash: staff.passwordHash })
          .from(staff)
          .where(and(eq(staff.role, 'admin'), eq(staff.isActive, true), isNotNull(staff.passwordHash)));
        let matched: string | undefined;
        for (const a of admins) {
          if (!a.passwordHash) continue;
          // verifyPassword is constant-time per-hash; iterating is fine for
          // the realistic admin count (1–3).
          if (await verifyPassword(parsed.data.adminPassword, a.passwordHash)) {
            matched = a.id;
            break;
          }
        }
        if (!matched) {
          request.log.info(
            { initiatedBy: request.user.id, role: request.user.role },
            '[refund] admin password invalid',
          );
          return reply.code(403).send({ error: 'admin_password_invalid' });
        }
        approvedBy = matched;
      }

      const result = await refundEntry(db, {
        entryId,
        refundedBy: request.user.id,
        approvedBy,
        reason: parsed.data.reason,
      });
      if (!result.ok) {
        if (result.reason === 'entry_not_found')
          return reply.code(404).send({ error: 'entry_not_found' });
        if (result.reason === 'already_refunded')
          return reply.code(409).send({ error: 'already_refunded' });
        if (result.reason === 'card_cancelled')
          return reply.code(409).send({ error: 'card_cancelled' });
      } else {
        // Cheap sanity check: the refunded entry should belong to the cardId
        // in the URL. Mismatch is almost certainly a stale UI calling a wrong
        // path, not an attack — server still applied the refund correctly
        // because we trust the entryId, but log it.
        if (result.cardId !== cardId) {
          request.log.warn(
            { paramCardId: cardId, entryCardId: result.cardId },
            '[refund] cardId/entryId mismatch in URL — refund applied to the entry-owning card',
          );
        }
        request.log.info(
          {
            entryId,
            cardId: result.cardId,
            reactivated: result.reactivated,
            initiatedBy: request.user.id,
            approvedBy,
          },
          '[refund] applied',
        );
        return reply.send({
          entryId: result.entryId,
          cardId: result.cardId,
          usedEntries: result.usedEntries,
          totalEntries: result.totalEntries,
          remaining: result.remaining,
          reactivated: result.reactivated,
        });
      }
      return reply.code(500).send({ error: 'unknown' });
    },
  );

  // Admin-only card creation with full override of totalEntries + validityDays
  // + source. Used for gift cards, VIP setups, and back-office adjustments.
  fastify.post(
    '/admin/cards',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const parsed = adminCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      // Validate customer exists up-front for a cleaner 404 (the FK would
      // otherwise surface as a Postgres error).
      const customer = await getCustomerById(db, parsed.data.customerId);
      if (!customer) return reply.code(404).send({ error: 'customer_not_found' });

      const card = await createPunchCard(db, envKeyResolver, {
        customerId: parsed.data.customerId,
        ...(parsed.data.totalEntries !== undefined && { totalEntries: parsed.data.totalEntries }),
        ...(parsed.data.validityDays !== undefined && { validityDays: parsed.data.validityDays }),
        source: parsed.data.source ?? 'manual',
      });
      request.log.info(
        {
          cardId: card.id,
          serial: card.serialNumber,
          customerId: parsed.data.customerId,
          override: {
            totalEntries: parsed.data.totalEntries ?? null,
            validityDays: parsed.data.validityDays ?? null,
          },
        },
        '[admin create-card] success',
      );
      return reply.code(201).send({ card });
    },
  );

  // Admin-only: move a card to a different customer. Entries stay attached.
  fastify.post(
    '/cards/:id/reassign',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const parsed = reassignBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await reassignCard(db, {
        cardId: id,
        newCustomerId: parsed.data.customerId,
        ...(request.user && { staffId: request.user.id }),
      });
      if (!result.ok) {
        if (result.reason === 'card_not_found')
          return reply.code(404).send({ error: 'card_not_found' });
        if (result.reason === 'customer_not_found')
          return reply.code(404).send({ error: 'customer_not_found' });
        if (result.reason === 'card_cancelled')
          return reply.code(409).send({ error: 'card_cancelled' });
        if (result.reason === 'same_customer')
          return reply.code(409).send({ error: 'same_customer' });
      } else {
        request.log.info(
          {
            cardId: id,
            toCustomerId: parsed.data.customerId,
            fromCustomerNumber: result.fromCustomerNumber,
          },
          '[reassign] success',
        );
        return reply.send({ card: result.card, fromCustomerNumber: result.fromCustomerNumber });
      }
      return reply.code(500).send({ error: 'unknown' });
    },
  );
};
