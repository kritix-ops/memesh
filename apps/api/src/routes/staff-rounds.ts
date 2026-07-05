import {
  dashboardLiveRoundsForDate,
  dashboardLiveWaitlist,
  db,
  getDashboardSettings,
  listCustomerRoundBookingsForDate,
  listRoundAttendees,
  lookupBookingForCheckin,
  setBookingArrival,
  venueTodayIso,
} from '@memesh/db';
import { verifyBookingToken } from '@memesh/qr-engine';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';

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
  const rounds = await dashboardLiveRoundsForDate(db, dateIso, now);
  const waitlistRows = dateIso === todayIso ? await dashboardLiveWaitlist(db, now) : [];
  return {
    asOf: now.toISOString(),
    date: dateIso,
    settings: {
      refreshIntervalSeconds: settings.refreshIntervalSeconds,
      capacityWarningPct: settings.capacityWarningPct,
      capacityDangerPct: settings.capacityDangerPct,
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
        const code = result.error === 'not_found' ? 404 : 409; // not_markable / not_today
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
};
