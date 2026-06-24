import {
  cancelCard,
  cardDetail,
  createPunchCard,
  db,
  editCard,
  getCardSettings,
  getCustomerById,
  listCards,
  mintHandoffToken,
  reassignCard,
  refundEntry,
  staff,
} from '@memesh/db';
import { verifyPassword } from '@memesh/auth';
import { createHash } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';
import { buildPostSaleSmsBody } from '../lib/post-sale-sms.js';
import { firePostPurchaseEmail } from '../lib/post-purchase-email.js';
import { smsProvider } from '../lib/sms.js';
import { verifyStaffPin } from '../lib/staff-pin-repo.js';

const STAFF = ['cashier', 'manager', 'admin'] as const;

// pos_sell handoff tokens live longer than wc_checkout ones (24h vs 5min).
// An SMS may sit unread on the customer's phone for hours — the link still
// needs to work when they get around to it. Single-use still applies, so a
// leaked SMS is good for at most one sign-in inside the window.
const POS_SELL_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

const createBodySchema = z.object({
  customerId: z.string().uuid(),
  totalEntries: z.number().int().positive().max(100).optional(),
  source: z.enum(['pos', 'online', 'manual']).optional(),
  // Receipt number from the AccuPOS register. Enforced as required at this
  // route when settings.requireReceiptNumberOnPos is true AND the effective
  // source resolves to 'pos'. Always required to be 1..64 chars when present
  // so a stray empty string can't slip past the DB unique constraint.
  receiptNumber: z.string().trim().min(1).max(64).optional(),
  // Cashier attribution PIN (digits). Enforced when
  // settings.requireSellerPin is true. The route never echoes this back.
  sellerPin: z.string().regex(/^\d+$/).min(3).max(12).optional(),
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

// Edit body. Each field optional. For expiresAt:
//   - omitted = keep current value
//   - null    = forever (no expiry)
//   - "YYYY-MM-DD" = set to that day (end-of-day server-side)
const editBodySchema = z.object({
  totalEntries: z.number().int().min(1).max(1000).optional(),
  source: z.enum(['pos', 'online', 'manual']).optional(),
  expiresAt: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
    .optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['active', 'expired', 'cancelled']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export const cardsRoutes: FastifyPluginAsync = async (fastify) => {
  // Sell a punch card. Payment is taken externally (AccuPOS); staff confirm here,
  // then the server allocates a serial, mints the signed QR, and stores the card.
  fastify.post('/cards', { preHandler: requireRoleHook(...STAFF) }, async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    if (!request.user) return reply.code(401).send({ error: 'unauthorized' });

    const settings = await getCardSettings(db);
    const effectiveSource = parsed.data.source ?? 'pos';
    const isPos = effectiveSource === 'pos';

    // Anti-fraud gates apply to over-the-counter sales only. Admin-issued
    // gift cards go through /admin/cards and bypass both.
    if (isPos && settings.requireReceiptNumberOnPos && !parsed.data.receiptNumber) {
      return reply.code(400).send({ error: 'receipt_number_required' });
    }
    if (isPos && settings.requireSellerPin) {
      if (!parsed.data.sellerPin) {
        return reply.code(400).send({ error: 'pin_required' });
      }
      const verdict = await verifyStaffPin(request.user.id, parsed.data.sellerPin);
      if (!verdict.ok) {
        if (verdict.reason === 'no_pin') {
          request.log.info(
            { staffId: request.user.id },
            '[pos sell] pin_not_set — manager must set this cashier a PIN first',
          );
          return reply.code(412).send({ error: 'pin_not_set' });
        }
        if (verdict.reason === 'locked') {
          const retryAfterSec = Math.max(
            1,
            Math.ceil((verdict.lockedUntil.getTime() - Date.now()) / 1000),
          );
          request.log.warn(
            { staffId: request.user.id, retryAfterSec },
            '[pos sell] pin_locked',
          );
          return reply.code(423).send({ error: 'pin_locked', retryAfterSec });
        }
        // invalid_pin — surface "now locked" so the UI can show the right
        // message. We deliberately do NOT echo failedCount so a remote
        // attacker can't tell exactly how close they are to lockout.
        request.log.info(
          { staffId: request.user.id, lockedAfter: verdict.locked },
          '[pos sell] invalid_pin',
        );
        return reply.code(401).send({
          error: verdict.locked ? 'pin_locked_now' : 'invalid_pin',
        });
      }
    }

    let card;
    try {
      card = await createPunchCard(db, envKeyResolver, {
        customerId: parsed.data.customerId,
        ...(parsed.data.totalEntries !== undefined && { totalEntries: parsed.data.totalEntries }),
        ...(parsed.data.source !== undefined && { source: parsed.data.source }),
        ...(parsed.data.receiptNumber !== undefined && {
          receiptNumber: parsed.data.receiptNumber,
        }),
        // Always stamp soldBy when a cashier is at the keyboard, even if the
        // settings have the PIN gate disabled — the audit trail is the point.
        soldBy: request.user.id,
      });
    } catch (err) {
      // 23505 = unique_violation. Only happens when the receipt number was
      // already used by another card — the lazy version of cashier fraud.
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === '23505') {
        request.log.warn(
          { receiptNumber: parsed.data.receiptNumber, staffId: request.user.id },
          '[pos sell] receipt_number_duplicate',
        );
        return reply.code(409).send({ error: 'receipt_number_duplicate' });
      }
      throw err;
    }
    request.log.info(
      {
        cardId: card.id,
        serial: card.serialNumber,
        soldBy: request.user.id,
        receiptNumber: parsed.data.receiptNumber ?? null,
        source: effectiveSource,
      },
      '[pos sell] created',
    );

    // Fire-and-log post-sale SMS with a magic link into the customer area.
    // Failures never bubble up — the sale must not fail because SMS failed.
    //
    // THIS IS A TRANSACTIONAL SEND, NOT MARKETING. The customer just paid
    // for the card; confirming "your card is ready, here is the link" is
    // covered by the transactional exception in Israeli Comm. Act amend. 40
    // (חוק התקשורת תיקון 40), so we deliberately bypass:
    //   - `marketingConsentAt` (legal gate for marketing only)
    //   - quiet hours (a customer at the desk wants confirmation NOW)
    // What we DO honor:
    //   - `smsOnPurchase` — operator master switch for "send any post-sale
    //     SMS at all" (cost control, dev envs, brand preference).
    //
    // The cashier-facing success screen needs to reflect the smsOnPurchase
    // kill-switch honestly — when the switch is off, promising an SMS that
    // never gets sent is exactly the kind of trust hole the rule-16 audit is
    // meant to close. We snapshot the flag at the moment of sale (the value
    // the inner block will re-read could change between, but the response is
    // what the cashier sees).
    //
    // See _plans/2026-06-22-pos-sell-sms-magic-link.md for the design and
    // the decision record that flipped this from marketing to transactional.
    const smsWillSend = settings.smsOnPurchase;
    void (async () => {
      try {
        const customer = await getCustomerById(db, parsed.data.customerId);
        if (!customer) return;
        const cardSettings = await getCardSettings(db);
        if (!cardSettings.smsOnPurchase) {
          request.log.info(
            { cardId: card.id },
            '[cards post-sale] skipped: smsOnPurchase disabled',
          );
          return;
        }
        const minted = await mintHandoffToken(db, {
          customerId: customer.id,
          source: 'pos_sell',
          orderRef: card.id,
          ttlMs: POS_SELL_HANDOFF_TTL_MS,
        });
        const tokenHashPrefix = createHash('sha256')
          .update(minted.raw)
          .digest('hex')
          .slice(0, 8);
        request.log.info(
          {
            cardId: card.id,
            customerId: customer.id,
            tokenHashPrefix,
            expiresAt: minted.expiresAt.toISOString(),
          },
          '[cards post-sale] minted handoff token',
        );
        // Short-link path — see _plans/2026-06-22-sms-short-link.md.
        // The 16-char token + /c/ path keeps the SMS body inside a single
        // Hebrew-unicode segment instead of bleeding into a second.
        const link = `${env.CUSTOMER_BASE_URL}/c/${minted.raw}`;
        const body = buildPostSaleSmsBody({
          cards: [{ totalEntries: card.totalEntries, expiresAt: card.expiresAt }],
          link,
        });
        const res = await smsProvider.send({ to: customer.phone, body });
        if (res.ok) {
          request.log.info(
            { cardId: card.id, tokenHashPrefix, providerId: res.id ?? null },
            '[cards post-sale] sms sent',
          );
        } else {
          request.log.warn(
            { cardId: card.id, tokenHashPrefix, error: res.error },
            '[cards post-sale] sms provider error',
          );
        }
      } catch (err) {
        request.log.warn({ err }, '[cards] post-sale SMS failed silently');
      }
    })();

    // Post-sale email — runs in parallel to the SMS block above. Each
    // channel has its OWN try/catch + its OWN handoff token (per the
    // 2026-06-23 dual-channel decision) so an SMS provider hiccup never
    // suppresses the email and vice-versa. firePostPurchaseEmail self-
    // skips when the customer has no email on file (POS-registered
    // customers may not have one) or when emailOnPurchase is disabled.
    void (async () => {
      try {
        const customer = await getCustomerById(db, parsed.data.customerId);
        if (!customer) return;
        await firePostPurchaseEmail(db, {
          customerId: customer.id,
          customerEmail: customer.email,
          customerFirstName: customer.firstName,
          source: 'pos_sell',
          orderRef: card.id,
          cards: [{ totalEntries: card.totalEntries, expiresAt: card.expiresAt }],
          log: request.log,
        });
      } catch (err) {
        request.log.warn({ err }, '[cards] post-sale email failed silently');
      }
    })();

    return reply.code(201).send({ card, smsWillSend });
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

  // Admin-only: edit an existing card (expiry, total entries, source).
  // Used to be set-once at create time; this route lets the admin
  // adjust mistakes or extend a card's lifetime after the fact.
  fastify.post(
    '/cards/:id/edit',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const parsed = editBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const input: Parameters<typeof editCard>[1] = { cardId: id };
      if (request.user) input.staffId = request.user.id;
      if (parsed.data.totalEntries !== undefined) input.totalEntries = parsed.data.totalEntries;
      if (parsed.data.source !== undefined) input.source = parsed.data.source;
      if (parsed.data.expiresAt !== undefined) {
        if (parsed.data.expiresAt === null) {
          input.expiresAt = null;
        } else {
          // End of the chosen day in UTC. We store with TZ so the cashier's
          // local-day boundary holds when reading back via toISOString().
          const [y, m, d] = parsed.data.expiresAt.split('-').map(Number);
          input.expiresAt = new Date(Date.UTC(y!, (m as number) - 1, d, 23, 59, 59, 999));
        }
      }

      const result = await editCard(db, input);
      if (!result.ok) {
        if (result.reason === 'card_not_found')
          return reply.code(404).send({ error: 'card_not_found' });
        if (result.reason === 'card_cancelled')
          return reply.code(409).send({ error: 'card_cancelled' });
        if (result.reason === 'total_below_used')
          return reply
            .code(409)
            .send({ error: 'total_below_used', usedEntries: result.usedEntries });
        if (result.reason === 'total_out_of_range')
          return reply.code(400).send({ error: 'total_out_of_range' });
        if (result.reason === 'no_changes')
          return reply.code(409).send({ error: 'no_changes' });
      } else {
        request.log.info(
          { cardId: id, diff: result.diff, reactivated: result.reactivated },
          '[cards] edited',
        );
        return reply.send({
          card: result.card,
          diff: result.diff,
          reactivated: result.reactivated,
        });
      }
      return reply.code(500).send({ error: 'unknown' });
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
