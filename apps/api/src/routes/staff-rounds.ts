import { dashboardLiveRoundsToday, dashboardLiveWaitlist, db, getDashboardSettings } from '@memesh/db';
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
  settings: StaffRoundsSettings;
  rounds: StaffRoundsRound[];
  waitlist: StaffRoundsWaitlist[];
};

// 5s in-memory cache, same rationale as the admin live endpoint: a handful of
// cashiers polling every ~30s shouldn't each hit the DB. Per-process, TTL-only.
const CACHE_TTL_MS = 5_000;
type Cached = { data: StaffRoundsResponse; expiresAt: number };
let cache: Cached | null = null;

async function computeStaffRounds(): Promise<StaffRoundsResponse> {
  const now = new Date();
  // Sequential — PGlite (test fixture) is single-connection; prod driver is
  // fine serial and the total stays well under 100ms.
  const settings = await getDashboardSettings(db);
  const rounds = await dashboardLiveRoundsToday(db, now);
  const waitlistRows = await dashboardLiveWaitlist(db, now);
  return {
    asOf: now.toISOString(),
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

async function getCachedStaffRounds(): Promise<StaffRoundsResponse> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.data;
  const data = await computeStaffRounds();
  cache = { data, expiresAt: now + CACHE_TTL_MS };
  return data;
}

// Test seam — reset the cache between assertions.
export function _resetStaffRoundsCacheForTests(): void {
  cache = null;
}

export const staffRoundsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/staff/rounds/today',
    { preHandler: requireRoleHook(...STAFF) },
    async (request): Promise<StaffRoundsResponse> => {
      const t0 = Date.now();
      const data = await getCachedStaffRounds();
      request.log.info(
        { ms: Date.now() - t0, rounds: data.rounds.length },
        '[staff rounds today] served',
      );
      return data;
    },
  );
};
