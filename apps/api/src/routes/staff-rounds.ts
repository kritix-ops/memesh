import {
  dashboardLiveRoundsForDate,
  dashboardLiveWaitlist,
  db,
  getDashboardSettings,
  listRoundAttendees,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { requireRoleHook } from '../lib/auth-guards.js';

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

function localIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

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
      const todayIso = localIsoDate(new Date());
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

  // Who's booked on a round + arrival status — the floor's "מי הגיע" list
  // (Yanay 2026-07-04). Names only, never phone/email: check-in matches a
  // person at the door, it doesn't contact them. All staff roles may read.
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
};
