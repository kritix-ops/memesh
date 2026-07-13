import {
  addWalkInBooking,
  cancelBooking,
  dashboardLiveRoundsForDate,
  dashboardLiveWaitlist,
  db,
  getDashboardSettings,
  getOrCreateWalkInCustomerId,
  getRoundSettings,
  listCustomerRoundBookingsForDate,
  listRoundAttendees,
  lookupBookingForCheckin,
  promoteWaitlist,
  setBookingArrival,
  swapBooking,
  venueTodayIso,
} from '@memesh/db';
import { verifyBookingToken } from '@memesh/qr-engine';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { makeRoundRefund } from '../lib/round-refund.js';
import { fireWaitlistOffer } from '../lib/waitlist-notify.js';
import { envKeyResolver } from '../qr.js';

// Offer a freed/vacated seat to the round's next waitlisted customer after a
// staff removal or move. Never fails the caller — a promotion error is logged
// and the hold-sweep cron retries. Mirrors rounds-booking.ts's helper so the
// waitlist behaves identically no matter who freed the seat.
const promoteFreedSeat = async (
  roundInstanceId: string,
  log: FastifyBaseLogger,
): Promise<void> => {
  try {
    const res = await promoteWaitlist(db, roundInstanceId);
    if (res.promoted) {
      log.info(
        { roundInstanceId, entryId: res.promoted.entryId },
        '[staff rounds] waitlist promoted',
      );
      await fireWaitlistOffer(res.promoted, log);
    }
  } catch (err) {
    log.error({ err, roundInstanceId }, '[staff rounds] waitlist promote failed (non-fatal)');
  }
};

// Read-only rounds status for the shift floor (staff.memesh.co.il). Reuses the
// same DB helpers as the admin live dashboard so occupancy is a single source
// of truth, but deliberately exposes only occupancy + waitlist counts — no
// revenue, no stats, no customer PII. All staff roles may read it.
const STAFF = ['cashier', 'manager', 'admin'] as const;

// Response shape — mirrored by apps/staff/src/lib/api/rounds.ts.
export type StaffRoundsRound = {
  roundInstanceId: string;
  label: string;
  startTime: string;
  endTime: string;
  capacity: number;
  /** confirmed + used + active holds */
  taken: number;
  /** Active pre-payment holds — the "בתהליך תשלום" slice of `taken`. */
  heldCount: number;
  /** Real bookings: confirmed + used (holds excluded). */
  bookedCount: number;
  /** Checked in at the door — "כמה הגיעו". */
  arrivedCount: number;
  /** 0..100, rounded. */
  pctFull: number;
  isClosed: boolean;
};

export type StaffRoundsWaitlist = {
  roundInstanceId: string;
  label: string;
  waitingCount: number;
};

export type StaffRoundsSettings = {
  refreshIntervalSeconds: number;
  capacityWarningPct: number;
  capacityDangerPct: number;
  /** Minutes after a round ends that staff may still mark arrivals. */
  markingGraceMinutes: number;
};

export type StaffRoundsResponse = {
  asOf: string;
  /** The calendar date this response describes (YYYY-MM-DD). */
  date: string;
  settings: StaffRoundsSettings;
  rounds: StaffRoundsRound[];
  /** Populated for today only — future waitlists aren't a floor concern. */
  waitlist: StaffRoundsWaitlist[];
};

// 5s in-memory cache per date, same rationale as the admin live endpoint: a
// handful of cashiers polling every ~30s shouldn't each hit the DB. The map
// stays tiny (a shift looks at today ± a few days); stale entries are evicted
// on write.
const CACHE_TTL_MS = 5_000;
type Cached = { data: StaffRoundsResponse; expiresAt: number };
const cache = new Map<string, Cached>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function computeStaffRounds(dateIso: string, todayIso: string): Promise<StaffRoundsResponse> {
  const now = new Date();
  // Sequential — PGlite (test fixture) is single-connection; prod driver is
  // fine serial and the total stays well under 100ms.
  const settings = await getDashboardSettings(db);
  const roundSettings = await getRoundSettings(db);
  const rounds = await dashboardLiveRoundsForDate(db, dateIso, now);
  const waitlistRows = dateIso === todayIso ? await dashboardLiveWaitlist(db, now) : [];
  return {
    asOf: now.toISOString(),
    date: dateIso,
    settings: {
      refreshIntervalSeconds: settings.refreshIntervalSeconds,
      capacityWarningPct: settings.capacityWarningPct,
      capacityDangerPct: settings.capacityDangerPct,
      markingGraceMinutes: roundSettings.markingGraceMinutes,
    },
    rounds: rounds.map((r) => ({
      roundInstanceId: r.roundInstanceId,
      label: r.label,
      startTime: r.startTime,
      endTime: r.endTime,
      capacity: r.capacity,
      taken: r.taken,
      heldCount: r.heldCount,
      bookedCount: r.bookedCount,
      arrivedCount: r.arrivedCount,
      pctFull: r.pctFull,
      isClosed: r.isClosed,
    })),
    waitlist: waitlistRows.map((w) => ({
      roundInstanceId: w.roundInstanceId,
      label: w.label,
      waitingCount: w.waitingCount,
    })),
  };
}

async function getCachedStaffRounds(dateIso: string, todayIso: string): Promise<StaffRoundsResponse> {
  const now = Date.now();
  const hit = cache.get(dateIso);
  if (hit && hit.expiresAt > now) return hit.data;
  const data = await computeStaffRounds(dateIso, todayIso);
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  cache.set(dateIso, { data, expiresAt: now + CACHE_TTL_MS });
  return data;
}

// Test seam — reset the cache between assertions.
export function _resetStaffRoundsCacheForTests(): void {
  cache.clear();
}

export const staffRoundsRoutes: FastifyPluginAsync = async (fastify) => {
  // Kept at /today for backward compatibility; `?date=YYYY-MM-DD` reads any
  // day so the floor can verify a future booking landed (Yanay 2026-07-04).
  fastify.get(
    '/staff/rounds/today',
    { preHandler: requireRoleHook(...STAFF) },
    async (request, reply): Promise<StaffRoundsResponse> => {
      const t0 = Date.now();
      // Venue date, never the server's — the host runs on UTC, so around
      // midnight Israel time the two disagree (Yoav 2026-07-05).
      const todayIso = venueTodayIso(new Date());
      const requested = (request.query as { date?: string }).date;
      if (requested !== undefined && !DATE_RE.test(requested)) {
        return reply.code(400).send({ error: 'invalid_date' }) as never;
      }
      const dateIso = requested ?? todayIso;
      const data = await getCachedStaffRounds(dateIso, todayIso);
      request.log.info(
        { ms: Date.now() - t0, date: dateIso, rounds: data.rounds.length },
        '[staff rounds] served',
      );
      return data;
    },
  );

  // Who's booked on a round + arrival status + contact details — the floor's
  // "מי הגיע" list (Yanay 2026-07-04; contact details explicitly requested so
  // staff can call a no-show). All staff roles may read, same trust level as
  // the POS customer search.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  fastify.get(
    '/staff/rounds/:roundInstanceId/attendees',
    { preHandler: requireRoleHook(...STAFF) },
    async (request, reply) => {
      const { roundInstanceId } = request.params as { roundInstanceId: string };
      if (!UUID_RE.test(roundInstanceId)) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const attendees = await listRoundAttendees(db, roundInstanceId);
      request.log.info(
        {
          roundInstanceId,
          attendees: attendees.length,
          arrived: attendees.filter((a) => a.arrived).length,
        },
        '[staff rounds attendees] served',
      );
      return { attendees };
    },
  );

  // Manual arrival marking (plan 2026-07-05-staff-manual-arrival): the floor
  // often doesn't scan, so staff mark a booked customer in (or undo a mistaken
  // tap) by hand. Same-venue-day only — enforced in the DB helper. All staff
  // roles: the counter can't wait for a manager on "oops, wrong person".
  const arrivalSchema = z.object({ arrived: z.boolean() });
  fastify.post(
    '/staff/rounds/bookings/:bookingId/arrival',
    { preHandler: requireRoleHook(...STAFF) },
    async (request, reply) => {
      const { bookingId } = request.params as { bookingId: string };
      if (!UUID_RE.test(bookingId)) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const parsed = arrivalSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const result = await setBookingArrival(db, { bookingId, arrived: parsed.data.arrived });
      if (!result.ok) {
        const code = result.error === 'not_found' ? 404 : 409; // not_markable / not_today / round_ended
        return reply.code(code).send({ error: result.error });
      }
      request.log.info(
        { bookingId, arrived: result.arrived, changed: result.changed },
        '[staff arrival] set',
      );
      return { arrived: result.arrived, usedAt: result.usedAt, changed: result.changed };
    },
  );

  // Resolve a ticket for the door check-in screen — by scanned booking QR
  // (token family 'b1.', verified + version-checked so a screenshotted QR from
  // before a swap fails) or by the human-typed booking number R-YYYYMMDD-NNNN.
  // The confirm action is the arrival endpoint above; this is a pure read.
  const checkinLookupSchema = z
    .object({
      token: z.string().min(1).max(2048).optional(),
      bookingNumber: z.string().min(1).max(32).optional(),
    })
    .refine((b) => Boolean(b.token) || Boolean(b.bookingNumber), {
      message: 'token or bookingNumber is required',
    });
  fastify.post(
    '/staff/rounds/checkin/lookup',
    {
      preHandler: requireRoleHook(...STAFF),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = checkinLookupSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      let query: { bookingId: string; version: number } | { bookingNumber: string };
      if (parsed.data.token) {
        const verified = verifyBookingToken(parsed.data.token, envKeyResolver);
        if (!verified.ok) {
          request.log.warn({ reason: verified.error }, '[staff checkin] bad token');
          return reply.code(400).send({ error: 'invalid_token' });
        }
        query = { bookingId: verified.payload.bookingId, version: verified.payload.version };
      } else {
        query = { bookingNumber: parsed.data.bookingNumber! };
      }
      const result = await lookupBookingForCheckin(db, query);
      if (!result.ok) {
        const code = result.error === 'not_found' ? 404 : 409; // stale_qr
        return reply.code(code).send({ error: result.error });
      }
      request.log.info(
        {
          bookingId: result.booking.bookingId,
          by: parsed.data.token ? 'token' : 'number',
          status: result.booking.status,
        },
        '[staff checkin] lookup',
      );
      return { booking: result.booking };
    },
  );

  // A customer's bookings for the venue-local today — the POS "found them in
  // לקוחות, mark them in" path. Same trust level as the attendees list.
  fastify.get(
    '/staff/customers/:customerId/rounds-today',
    { preHandler: requireRoleHook(...STAFF) },
    async (request, reply) => {
      const { customerId } = request.params as { customerId: string };
      if (!UUID_RE.test(customerId)) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const date = venueTodayIso(new Date());
      const bookings = await listCustomerRoundBookingsForDate(db, customerId, date);
      request.log.info(
        { customerId, date, bookings: bookings.length },
        '[staff customer rounds] served',
      );
      return { date, bookings };
    },
  );

  // Move a booking to a different round instance — the floor relocating an
  // early/late arrival (Yanay 2026-07-07: booked 14:00, showed up at 08:00).
  // Any staff role; acts on any customer's booking (no ownership check) and
  // skips the customer's "before original start" gate. The target's capacity
  // still applies — a full target is refused; use a walk-in for over-capacity.
  const moveSchema = z.object({ targetRoundInstanceId: z.string().uuid() });
  fastify.post(
    '/staff/rounds/bookings/:bookingId/move',
    { preHandler: requireRoleHook(...STAFF) },
    async (request, reply) => {
      const { bookingId } = request.params as { bookingId: string };
      if (!UUID_RE.test(bookingId)) return reply.code(400).send({ error: 'invalid_id' });
      const parsed = moveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const result = await swapBooking(
        db,
        { bookingId, targetRoundInstanceId: parsed.data.targetRoundInstanceId, skipWindow: true },
        envKeyResolver,
      );
      if (!result.ok) {
        const code =
          result.error === 'not_found' || result.error === 'target_not_found' ? 404 : 409; // not_confirmed / same_round / target_closed / target_full
        return reply.code(code).send({ error: result.error });
      }
      request.log.info(
        { bookingId, to: parsed.data.targetRoundInstanceId, staffId: request.user?.id },
        '[staff rounds move] done',
      );
      // The move freed a seat in the original round — offer it to its waitlist.
      await promoteFreedSeat(result.vacatedRoundInstanceId, request.log);
      return { bookingId: result.bookingId, barcodeToken: result.barcodeToken };
    },
  );

  // Add a walk-in to a round from the floor, even when it's full (Yanay
  // 2026-07-07). The booking is source='manual' so it stays visibly separate
  // from the ones who registered. Over-capacity is gated by the venue setting
  // allowOverCapacityWalkIn (default on). Any staff role.
  //
  // `anonymous: true` is the cash-no-info path (Yanay 2026-07-13): the floor
  // takes cash and drops a head onto the round without collecting a name or
  // phone. It books under the reserved walk-in customer, so `customerId` is
  // then unnecessary; without `anonymous`, `customerId` is required as before.
  const walkInSchema = z
    .object({
      customerId: z.string().uuid().optional(),
      anonymous: z.boolean().optional(),
      ticketType: z.enum(['child_under_walking', 'child_over_walking']).optional(),
    })
    .refine((v) => v.anonymous === true || typeof v.customerId === 'string', {
      message: 'customerId is required unless anonymous is true',
      path: ['customerId'],
    });
  fastify.post(
    '/staff/rounds/:roundInstanceId/walk-in',
    { preHandler: requireRoleHook(...STAFF) },
    async (request, reply) => {
      const { roundInstanceId } = request.params as { roundInstanceId: string };
      if (!UUID_RE.test(roundInstanceId)) return reply.code(400).send({ error: 'invalid_id' });
      const parsed = walkInSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const anonymous = parsed.data.anonymous === true;
      const customerId = anonymous
        ? await getOrCreateWalkInCustomerId(db)
        : parsed.data.customerId;
      if (!customerId) return reply.code(400).send({ error: 'invalid_body' });
      const settings = await getRoundSettings(db);
      const result = await addWalkInBooking(
        db,
        {
          roundInstanceId,
          customerId,
          allowOverCapacity: settings.allowOverCapacityWalkIn,
          ...(parsed.data.ticketType ? { ticketType: parsed.data.ticketType } : {}),
          ...(request.user ? { staffId: request.user.id } : {}),
        },
        envKeyResolver,
      );
      if (!result.ok) {
        const code =
          result.error === 'round_not_found' || result.error === 'customer_not_found' ? 404 : 409; // round_closed / round_full
        return reply.code(code).send({ error: result.error });
      }
      request.log.info(
        {
          roundInstanceId,
          customerId,
          anonymous,
          overCapacity: result.overCapacity,
          staffId: request.user?.id,
        },
        '[staff rounds walk-in] added',
      );
      return {
        bookingId: result.bookingId,
        barcodeToken: result.barcodeToken,
        bookingNumber: result.bookingNumber,
        overCapacity: result.overCapacity,
        taken: result.taken,
        capacity: result.capacity,
      };
    },
  );

  // Remove a booking from a round (ADMIN only — it can move money). A paid
  // booking is refunded fail-closed via WooCommerce (the seat is released only
  // once the refund confirms); a punch-card booking returns the spent entry to
  // the customer's card. The 24h cancel window is skipped — admin override.
  fastify.post(
    '/staff/rounds/bookings/:bookingId/cancel',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const { bookingId } = request.params as { bookingId: string };
      if (!UUID_RE.test(bookingId)) return reply.code(400).send({ error: 'invalid_id' });
      // Same interim manual-refund mode as the customer route (Yanay 2026-07-13):
      // while auto-refund is down, an admin removal frees the seat and the admin
      // refunds by hand, instead of failing closed with a 502.
      const settings = await getRoundSettings(db);
      const refund = makeRoundRefund(request.log);
      const result = await cancelBooking(
        db,
        { bookingId, skipWindow: true, manualRefund: settings.manualRefundOnCancel },
        { refund },
      );
      if (!result.ok) {
        const code =
          result.error === 'not_found'
            ? 404
            : result.error === 'refund_failed'
              ? 502 // refund provider couldn't confirm — seat kept, nothing changed
              : 409; // not_confirmed (already cancelled / used)
        return reply.code(code).send({ error: result.error });
      }
      request.log.info(
        {
          bookingId,
          staffId: request.user?.id,
          refunded: result.refunded,
          punchReturned: result.punchReturned,
        },
        '[staff rounds remove] done',
      );
      // The removal freed a seat — offer it to the round's waitlist.
      await promoteFreedSeat(result.roundInstanceId, request.log);
      return {
        ok: true,
        refunded: result.refunded,
        punchReturned: result.punchReturned,
        refundAmountIls: result.refundAmountIls,
      };
    },
  );
};
