import { timingSafeEqual } from 'node:crypto';
import {
  cancelBooking,
  createHold,
  db,
  listCustomerRoundBookings,
  mintBooking,
  releaseHold,
  resolveOrCreateCustomerFromWc,
  roundAvailabilityForDate,
  swapBooking,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { requireCustomer } from '../lib/customer-guard.js';
import { phoneSchema } from '../lib/phone-schema.js';
import { createWcRestClient } from '../lib/wc-rest-client.js';
import { envKeyResolver } from '../qr.js';

// Customer-facing rounds flow. Availability is PUBLIC — the WordPress round
// picker reads it before the customer logs in — and rate-limited so it can't be
// scraped or used to exhaust the DB. Hold + release are customer-gated (a
// booking is bound to its owner). Later PRs add mint / swap / cancel here.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const holdSchema = z.object({
  roundInstanceId: z.string().uuid(),
  ticketType: z.enum(['child_under_walking', 'child_over_walking']),
  additionalCompanions: z.number().int().min(0).max(1).optional(),
});

const releaseSchema = z.object({ holdId: z.string().uuid() });
const devPaySchema = z.object({ holdId: z.string().uuid() });
const swapSchema = z.object({
  bookingId: z.string().uuid(),
  targetRoundInstanceId: z.string().uuid(),
});
const cancelSchema = z.object({ bookingId: z.string().uuid() });

// Server-to-server hold from the WooCommerce checkout (super-brief §4.2). The
// WP shopper is a guest with no customer session, so identity travels as a
// hint (phone is the primary key, matching the existing WC order flow) and the
// call is authenticated by the shared secret WP already holds.
const wcHoldSchema = z.object({
  roundInstanceId: z.string().uuid(),
  ticketType: z.enum(['child_under_walking', 'child_over_walking']),
  additionalCompanions: z.number().int().min(0).max(1).optional(),
  customerHint: z.object({
    phone: phoneSchema,
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    email: z.string().email().max(255).optional(),
    wpUserId: z.number().int().nonnegative().optional(),
    marketingConsent: z.boolean().optional(),
  }),
});

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

export const roundsBookingRoutes: FastifyPluginAsync = async (fastify) => {
  // Built once for the cancel refund path. Null when WC isn't configured — a
  // real paid booking then can't be refunded, so cancel fails closed rather
  // than releasing a seat with no money returned.
  const wcClient =
    env.WC_API_URL && env.WC_API_CONSUMER_KEY && env.WC_API_CONSUMER_SECRET
      ? createWcRestClient({
          baseUrl: env.WC_API_URL,
          consumerKey: env.WC_API_CONSUMER_KEY,
          consumerSecret: env.WC_API_CONSUMER_SECRET,
        })
      : null;
  fastify.get(
    '/rounds/availability',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const date = (request.query as { date?: string }).date;
      if (!date || !DATE_RE.test(date)) {
        return reply.code(400).send({ error: 'invalid_date' });
      }
      const rows = await roundAvailabilityForDate(db, date);
      request.log.info({ date, rounds: rows.length }, '[rounds availability]');
      // Public shape: enough to render the picker, nothing internal (no
      // per-round revenue, no held/booking internals).
      return {
        date,
        rounds: rows.map((r) => ({
          roundInstanceId: r.roundInstanceId,
          label: r.label,
          startTime: r.startTime,
          endTime: r.endTime,
          capacity: r.capacity,
          available: r.available,
          isClosed: r.isClosed,
        })),
      };
    },
  );

  // The signed-in customer's active/upcoming round bookings + barcodes
  // (super-brief §11.3). Owner-scoped to the session customer.
  fastify.get('/rounds/my-bookings', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const rows = await listCustomerRoundBookings(db, customerId);
    request.log.info({ customerId, bookings: rows.length }, '[rounds my-bookings]');
    return { bookings: rows };
  });

  // Reserve one child seat before payment (super-brief §3). Customer-gated —
  // the held booking is bound to the session customer. Rate-limited so a
  // single account can't tie up capacity with a flood of holds.
  fastify.post(
    '/rounds/hold',
    { preHandler: requireCustomer, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const customerId = request.customer?.id;
      if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
      const parsed = holdSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const result = await createHold(db, {
        roundInstanceId: parsed.data.roundInstanceId,
        customerId,
        ticketType: parsed.data.ticketType,
        ...(parsed.data.additionalCompanions !== undefined
          ? { additionalCompanions: parsed.data.additionalCompanions }
          : {}),
      });
      if (!result.ok) {
        // not_found → 404; closed / sold_out → 409 (the request was valid, the
        // seat just isn't available).
        const code = result.error === 'not_found' ? 404 : 409;
        return reply.code(code).send({ error: result.error });
      }
      request.log.info({ holdId: result.holdId, customerId }, '[rounds hold] created');
      return { holdId: result.holdId, expiresAt: result.expiresAt };
    },
  );

  // The WooCommerce checkout's version of the hold (super-brief §4.2). Same
  // seat-reservation engine, different front door: authenticated by the shared
  // secret WP already uses (not a customer session), and it resolves the
  // customer from the checkout's phone/name so the seat is reserved the moment
  // the round is chosen — before payment. Feature-gated off until the secret is
  // set. Rate-limited as defense in depth (the secret is the real gate).
  fastify.post(
    '/rounds/hold/wc',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!env.WP_HANDOFF_SHARED_SECRET) {
        request.log.error('[rounds hold wc] WP_HANDOFF_SHARED_SECRET not configured');
        return reply.code(503).send({ error: 'not_configured' });
      }
      const auth = request.headers['authorization'];
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!constantTimeEqual(auth.slice('Bearer '.length), env.WP_HANDOFF_SHARED_SECRET)) {
        request.log.info('[rounds hold wc] wrong shared secret');
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const parsed = wcHoldSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const hint = parsed.data.customerHint;
      // Phone-primary resolve/create, the same identity bridge the WC order
      // webhook uses — so the hold's customer is the one who'll pay.
      const { customer } = await resolveOrCreateCustomerFromWc(db, {
        phone: hint.phone,
        firstName: hint.firstName,
        lastName: hint.lastName,
        email: hint.email ?? null,
        wpUserId: hint.wpUserId ?? null,
        marketingConsent: hint.marketingConsent ?? false,
      });
      const result = await createHold(db, {
        roundInstanceId: parsed.data.roundInstanceId,
        customerId: customer.id,
        ticketType: parsed.data.ticketType,
        source: 'paid',
        ...(parsed.data.additionalCompanions !== undefined
          ? { additionalCompanions: parsed.data.additionalCompanions }
          : {}),
      });
      if (!result.ok) {
        const code = result.error === 'not_found' ? 404 : 409;
        return reply.code(code).send({ error: result.error });
      }
      request.log.info(
        { holdId: result.holdId, customerId: customer.id, roundInstanceId: parsed.data.roundInstanceId },
        '[rounds hold wc] created',
      );
      return { holdId: result.holdId, expiresAt: result.expiresAt };
    },
  );

  // Release a held seat early. Owner-gated in the DB helper; the route also
  // passes the session customer so one customer can't release another's hold.
  fastify.post('/rounds/hold/release', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = releaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await releaseHold(db, parsed.data.holdId, customerId);
    if (!result.ok) {
      const code = result.error === 'not_found' ? 404 : result.error === 'forbidden' ? 403 : 409;
      return reply.code(code).send({ error: result.error });
    }
    request.log.info({ holdId: parsed.data.holdId, customerId }, '[rounds hold] released');
    return { ok: true };
  });

  // Change the time of a confirmed booking to another available round
  // (super-brief §6.1). Customer-gated + owner-checked in the DB helper. Atomic
  // move that can't oversell the target and re-mints the barcode.
  fastify.post('/rounds/swap', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = swapSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await swapBooking(
      db,
      {
        bookingId: parsed.data.bookingId,
        customerId,
        targetRoundInstanceId: parsed.data.targetRoundInstanceId,
      },
      envKeyResolver,
    );
    if (!result.ok) {
      const code =
        result.error === 'not_found' || result.error === 'target_not_found'
          ? 404
          : result.error === 'forbidden'
            ? 403
            : 409; // not_confirmed / too_late / same_round / target_closed / target_full
      return reply.code(code).send({ error: result.error });
    }
    request.log.info({ bookingId: result.bookingId, customerId }, '[rounds swap] done');
    return { bookingId: result.bookingId, barcodeToken: result.barcodeToken };
  });

  // Cancel a confirmed booking with an auto-refund (super-brief §6.2).
  // Customer-gated + owner-checked. The DB helper releases the seat only after
  // the refund is confirmed; if the refund can't be confirmed the booking stays
  // and we return 502 so the customer keeps their paid seat.
  fastify.post('/rounds/cancel', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const refund = async (wcOrderId: string, amountIls: number): Promise<boolean> => {
      // Dev-pay bookings have no real WC order; treat their refund as a no-op
      // success outside production so cancel is testable end to end.
      if (wcOrderId.startsWith('dev-')) return env.NODE_ENV !== 'production';
      if (!wcClient) {
        request.log.error({ wcOrderId }, '[rounds cancel] WC not configured — cannot refund');
        return false;
      }
      try {
        const r = await wcClient.createOrderRefund(wcOrderId, amountIls);
        request.log.info({ wcOrderId, refundId: r.id, amount: r.amount }, '[rounds cancel] refunded');
        return true;
      } catch (err) {
        request.log.error({ err, wcOrderId }, '[rounds cancel] refund failed');
        return false;
      }
    };
    const result = await cancelBooking(db, { bookingId: parsed.data.bookingId, customerId }, { refund });
    if (!result.ok) {
      const code =
        result.error === 'not_found'
          ? 404
          : result.error === 'forbidden'
            ? 403
            : result.error === 'refund_failed'
              ? 502 // refund provider couldn't confirm — seat kept, nothing changed
              : 409; // not_confirmed / too_late
      return reply.code(code).send({ error: result.error });
    }
    request.log.info(
      { bookingId: parsed.data.bookingId, customerId, refunded: result.refunded },
      '[rounds cancel] done',
    );
    return { ok: true, refunded: result.refunded, refundAmountIls: result.refundAmountIls };
  });

  // Dev-only "pay now" — simulates a completed WooCommerce payment for a held
  // seat so buy → booking can be exercised end to end before the WC wiring
  // lands. DISABLED in production (404) so it can never mint a free booking
  // there; owner-checked so a customer can only pay for their own hold.
  fastify.post('/rounds/dev-pay', { preHandler: requireCustomer }, async (request, reply) => {
    if (env.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = devPaySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await mintBooking(
      db,
      {
        holdId: parsed.data.holdId,
        wcOrderId: `dev-${parsed.data.holdId}`,
        source: 'paid',
        expectedCustomerId: customerId,
      },
      envKeyResolver,
    );
    if (!result.ok) {
      const code = result.error === 'not_found' ? 404 : result.error === 'forbidden' ? 403 : 409;
      return reply.code(code).send({ error: result.error });
    }
    request.log.info({ bookingId: result.booking.bookingId, customerId }, '[rounds dev-pay] minted');
    return {
      bookingId: result.booking.bookingId,
      barcodeToken: result.booking.barcodeToken,
      idempotentReplay: result.idempotentReplay,
    };
  });
};
