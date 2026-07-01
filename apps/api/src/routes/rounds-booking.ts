import { timingSafeEqual } from 'node:crypto';
import {
  anyActiveRounds,
  bookRoundWithPunch,
  cancelBooking,
  confirmCompanionUpgrade,
  createHold,
  db,
  getCardSettings,
  getCustomerById,
  getRoundSettings,
  joinWaitlist,
  leaveWaitlist,
  listCustomerRoundBookings,
  listCustomerWaitlist,
  mintBooking,
  prepareCompanionCheckout,
  promoteWaitlist,
  recordCompanionOrder,
  releaseHold,
  resolveOrCreateCustomerFromWc,
  resolveScheduleForDate,
  roundAvailabilityForDate,
  roundFitsWindows,
  swapBooking,
} from '@memesh/db';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { requireCustomer } from '../lib/customer-guard.js';
import { phoneSchema } from '../lib/phone-schema.js';
import { fireWaitlistOffer } from '../lib/waitlist-notify.js';
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
const companionCheckoutSchema = z.object({ bookingId: z.string().uuid() });
const devPaySchema = z.object({ holdId: z.string().uuid() });
const swapSchema = z.object({
  bookingId: z.string().uuid(),
  targetRoundInstanceId: z.string().uuid(),
});
const cancelSchema = z.object({ bookingId: z.string().uuid() });
const bookPunchSchema = z.object({
  roundInstanceId: z.string().uuid(),
  punchCardId: z.string().uuid(),
  ticketType: z.enum(['child_under_walking', 'child_over_walking']),
});
const waitlistJoinSchema = z.object({
  roundInstanceId: z.string().uuid(),
  ticketType: z.enum(['child_under_walking', 'child_over_walking']),
  additionalCompanions: z.number().int().min(0).max(1).optional(),
});
const waitlistLeaveSchema = z.object({ entryId: z.string().uuid() });

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

// Offer a freed seat to the next waitlisted customer (super-brief §8). Runs
// after the seat is released; never fails the caller's response — a promotion
// error is logged and the next slot-release (or the hold-sweep cron) retries.
// Push notification is wired in the follow-up; the offer already shows in the
// customer's personal area via /rounds/waitlist/mine.
const promoteFreedSeat = async (
  roundInstanceId: string,
  log: FastifyBaseLogger,
): Promise<void> => {
  try {
    const res = await promoteWaitlist(db, roundInstanceId);
    if (res.promoted) {
      log.info(
        { roundInstanceId, entryId: res.promoted.entryId, claimExpiresAt: res.promoted.claimExpiresAt },
        '[rounds waitlist] promoted',
      );
      await fireWaitlistOffer(res.promoted, log);
    }
  } catch (err) {
    log.error({ err, roundInstanceId }, '[rounds waitlist] promote failed (non-fatal)');
  }
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
      const cardSettings = await getCardSettings(db);
      const roundSettings = await getRoundSettings(db);
      // Schedule composition (plan 2026-07-02-round-schedule-rules): the
      // winning rule for this date filters which rounds are offered (fit
      // ENTIRELY inside a window) and decides whether picking one is
      // mandatory. free_play outside → rounds offered but optional;
      // closed outside → mandatory (and windows [] = nothing purchasable).
      const systemOn = roundSettings.roundsEnabled && (await anyActiveRounds(db));
      const schedule = systemOn ? await resolveScheduleForDate(db, date) : null;
      let rows = systemOn ? await roundAvailabilityForDate(db, date) : [];
      let roundsRequired = systemOn;
      if (systemOn && schedule) {
        rows = rows.filter((r) => roundFitsWindows(r.startTime, r.endTime, schedule.windows));
        roundsRequired = schedule.outside === 'closed';
      }
      request.log.info(
        { date, roundsRequired, rounds: rows.length, ruleId: schedule?.ruleId ?? null },
        '[rounds availability]',
      );
      // Public shape: enough to render the picker, nothing internal (no
      // per-round revenue, no held/booking internals). companionPriceIls is
      // public pricing (it's on the storefront anyway) so pickers show the
      // real settings price instead of a hardcoded number.
      return {
        date,
        roundsRequired,
        companionPriceIls: cardSettings.roundAdditionalCompanionPriceIls,
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

  // Is the rounds system in use at all? The WP product-page picker calls this
  // (server-side, cached in a transient) to decide whether choosing a round is
  // mandatory: master switch off or no active rounds → entry tickets sell as
  // plain products (Yanay 2026-07-02). Public + rate-limited like availability.
  fastify.get(
    '/rounds/enabled',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const settings = await getRoundSettings(db);
      const enabled = settings.roundsEnabled && (await anyActiveRounds(db));
      request.log.info({ enabled, masterSwitch: settings.roundsEnabled }, '[rounds enabled]');
      return { enabled };
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
    // The swap freed a seat in the original round — offer it to its waitlist.
    await promoteFreedSeat(result.vacatedRoundInstanceId, request.log);
    return { bookingId: result.bookingId, barcodeToken: result.barcodeToken };
  });

  // Book a round seat by spending one punch-card entry (super-brief §3.4). No
  // WooCommerce — the customer already paid for the card. Customer-gated;
  // ownership of the card is enforced in the DB helper.
  fastify.post('/rounds/book-punch', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = bookPunchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await bookRoundWithPunch(
      db,
      {
        roundInstanceId: parsed.data.roundInstanceId,
        customerId,
        punchCardId: parsed.data.punchCardId,
        ticketType: parsed.data.ticketType,
      },
      envKeyResolver,
    );
    if (!result.ok) {
      const code =
        result.error === 'round_not_found' || result.error === 'card_not_found'
          ? 404
          : result.error === 'card_forbidden'
            ? 403
            : 409; // round_closed / round_full / card_inactive / card_expired / card_exhausted
      return reply.code(code).send({ error: result.error });
    }
    request.log.info(
      { bookingId: result.bookingId, customerId, punchCardId: parsed.data.punchCardId },
      '[rounds book-punch] done',
    );
    return {
      bookingId: result.bookingId,
      barcodeToken: result.barcodeToken,
      remaining: result.remaining,
    };
  });

  // Start (or resume) the paid-extra-companion checkout for a punch booking
  // (plan 2026-07-02-punch-companion-upsell). Creates a pending WC order with
  // a fee line and returns its order-pay URL; the paid-order webhook confirms
  // the companion. Companions never consume capacity, so there is no hold.
  // Idempotent-ish: a pending order is reused, a paid one short-circuits.
  fastify.post(
    '/rounds/companion/checkout',
    { preHandler: requireCustomer, config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const customerId = request.customer?.id;
      if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
      const parsed = companionCheckoutSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const bookingId = parsed.data.bookingId;

      const prep = await prepareCompanionCheckout(db, { bookingId, customerId });
      if (!prep.ok) {
        const code =
          prep.error === 'not_found' ? 404 : prep.error === 'forbidden' ? 403 : 409;
        request.log.info({ bookingId, customerId, error: prep.error }, '[rounds companion checkout] rejected');
        return reply.code(code).send({ error: prep.error });
      }

      // Free per settings (price 0) — no order, confirm on the spot.
      if (prep.priceIls <= 0) {
        const res = await confirmCompanionUpgrade(db, { bookingId, wcOrderId: `free-${bookingId}` });
        if (!res.ok) return reply.code(409).send({ error: res.error });
        request.log.info({ bookingId, customerId }, '[rounds companion checkout] free — confirmed inline');
        return { confirmed: true, priceIls: 0 };
      }

      if (!wcClient || !env.WC_API_URL) {
        request.log.error({ bookingId }, '[rounds companion checkout] WC not configured');
        return reply.code(503).send({ error: 'wc_not_configured' });
      }
      const siteBase = env.WC_API_URL.replace(/\/wp-json\/.*$/, '');
      const payUrlFor = (orderId: number | string, orderKey: string): string =>
        `${siteBase}/checkout/order-pay/${orderId}/?pay_for_order=true&key=${encodeURIComponent(orderKey)}`;

      // Retry path: a previous checkout already created an order. Reuse it
      // while it can still be paid; short-circuit when it's already paid; fall
      // through to a fresh order when it was cancelled/deleted in WC.
      if (prep.booking.wcOrderId) {
        try {
          const existing = await wcClient.getOrder(prep.booking.wcOrderId);
          if (existing.status === 'processing' || existing.status === 'completed') {
            request.log.info(
              { bookingId, wcOrderId: existing.id },
              '[rounds companion checkout] already paid — webhook confirms',
            );
            return { alreadyPaid: true, wcOrderId: existing.id };
          }
          if (existing.status === 'pending' || existing.status === 'on-hold' || existing.status === 'failed') {
            request.log.info(
              { bookingId, wcOrderId: existing.id, status: existing.status },
              '[rounds companion checkout] reusing pending order',
            );
            return { payUrl: payUrlFor(existing.id, existing.orderKey), wcOrderId: existing.id, priceIls: prep.priceIls };
          }
          // cancelled / refunded / trash → create a fresh order below.
        } catch (err) {
          request.log.warn(
            { err, bookingId, wcOrderId: prep.booking.wcOrderId },
            '[rounds companion checkout] existing order fetch failed — creating fresh',
          );
        }
      }

      const customer = await getCustomerById(db, customerId);
      if (!customer) return reply.code(401).send({ error: 'unauthorized' });
      let order;
      try {
        order = await wcClient.createOrder({
          billing: {
            first_name: customer.firstName,
            last_name: customer.lastName ?? '',
            phone: customer.phone,
            ...(customer.email ? { email: customer.email } : {}),
          },
          fee_lines: [
            {
              name: `מלווה נוסף — ${prep.booking.roundLabel} ${prep.booking.date} ${prep.booking.startTime}`,
              total: prep.priceIls.toFixed(2),
            },
          ],
          meta_data: [{ key: '_memesh_companion_booking_id', value: bookingId }],
        });
      } catch (err) {
        request.log.error({ err, bookingId }, '[rounds companion checkout] WC order create failed');
        return reply.code(502).send({ error: 'wc_order_create_failed' });
      }
      await recordCompanionOrder(db, { bookingId, wcOrderId: String(order.id) });
      request.log.info(
        { bookingId, customerId, wcOrderId: order.id, priceIls: prep.priceIls },
        '[rounds companion checkout] order created',
      );
      return { payUrl: payUrlFor(order.id, order.orderKey), wcOrderId: order.id, priceIls: prep.priceIls };
    },
  );

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
      {
        bookingId: parsed.data.bookingId,
        customerId,
        refunded: result.refunded,
        punchReturned: result.punchReturned,
      },
      '[rounds cancel] done',
    );
    // The cancellation freed a seat — offer it to the round's waitlist.
    await promoteFreedSeat(result.roundInstanceId, request.log);
    return {
      ok: true,
      refunded: result.refunded,
      punchReturned: result.punchReturned,
      refundAmountIls: result.refundAmountIls,
    };
  });

  // Join the waitlist for a full round (super-brief §8). Customer-gated.
  fastify.post('/rounds/waitlist/join', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = waitlistJoinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await joinWaitlist(db, {
      roundInstanceId: parsed.data.roundInstanceId,
      customerId,
      requestedType: parsed.data.ticketType,
      ...(parsed.data.additionalCompanions !== undefined
        ? { requestedCompanions: parsed.data.additionalCompanions }
        : {}),
    });
    if (!result.ok) {
      // round_not_found → 404; has_availability → 409 (go book instead).
      const code = result.error === 'round_not_found' ? 404 : 409;
      return reply.code(code).send({ error: result.error });
    }
    request.log.info(
      { entryId: result.entryId, customerId, position: result.position },
      '[rounds waitlist] joined',
    );
    return { entryId: result.entryId, position: result.position, alreadyOnList: result.alreadyOnList };
  });

  // Leave the waitlist. Owner-gated in the DB helper.
  fastify.post('/rounds/waitlist/leave', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = waitlistLeaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await leaveWaitlist(db, parsed.data.entryId, customerId);
    if (!result.ok) {
      const code = result.error === 'not_found' ? 404 : result.error === 'forbidden' ? 403 : 409;
      return reply.code(code).send({ error: result.error });
    }
    return { ok: true };
  });

  // The customer's active waitlist entries (waiting + notified offers).
  fastify.get('/rounds/waitlist/mine', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const entries = await listCustomerWaitlist(db, customerId);
    return { entries };
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
