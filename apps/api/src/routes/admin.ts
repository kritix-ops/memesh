import {
  dashboardLiveRoundsToday,
  dashboardLiveStats,
  dashboardLiveWaitlist,
  dashboardLiveWeekAhead,
  dashboardStats,
  db,
  dormantCustomers,
  listStaffActions,
  logStaffAction,
  reMintAllPunchCardTokens,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';

// ---------------------------------------------------------------------------
// Rounds-aware live dashboard response shape. The admin SPA mirrors this in
// its own lib/api/admin.ts (same pattern as the existing DashboardStats type).
//
// Step 1 (this PR): stubbed empty values, no DB reads. Step 2 wires the real
// queries against bookings / round_instances / waitlist_entries. Step 3 adds
// the revenue-privacy gate keyed on dashboard_settings.show_revenue.
// See _plans/2026-06-30-admin-rounds-dashboard.md for the full contract.
// ---------------------------------------------------------------------------

export type DashboardLiveStats = {
  revenueIls: number;
  /** Day-over-day delta at the same hour. null when yesterday's data point doesn't exist. */
  revenueDeltaPct: number | null;
  bookingsCount: number;
  bookingsDelta: number | null;
  activeHoldsCount: number;
  punchCardsSold: number;
  punchCardsDelta: number | null;
};

export type DashboardLiveRound = {
  roundInstanceId: string;
  label: string;
  /** "HH:MM" — local time, used for display + sort. */
  startTime: string;
  endTime: string;
  capacity: number;
  /** confirmed + used + active holds */
  taken: number;
  /** Just the active-hold portion of `taken`, for the "5 holds" stat. */
  heldCount: number;
  /** 0..100, rounded. */
  pctFull: number;
  /** True when the round_instance is manually closed (event, holiday). */
  isClosed: boolean;
};

export type DashboardLiveAlertKind =
  | 'payment_received_no_slot'
  | 'stuck_hold'
  | 'round_full_growing_waitlist';

export type DashboardLiveAlert = {
  id: string;
  kind: DashboardLiveAlertKind;
  /** Pre-rendered Hebrew message, server-localized. */
  message: string;
  /** Where clicking the alert takes the user (round detail, customer detail, etc.). */
  contextHref: string;
  occurredAt: string;
};

export type DashboardLiveWaitlist = {
  roundInstanceId: string;
  label: string;
  waitingCount: number;
  lastNotifiedAt: string | null;
};

export type DashboardLiveWeekAheadRound = {
  /** null when the round does NOT run on this date (e.g., Friday off). */
  roundInstanceId: string | null;
  /** Always present — the round's stable display name. */
  label: string;
  startTime: string;
  /** null when `roundInstanceId` is null. */
  pctFull: number | null;
  isClosed: boolean;
};

export type DashboardLiveWeekAheadDay = {
  /** YYYY-MM-DD */
  date: string;
  rounds: DashboardLiveWeekAheadRound[];
};

export type DashboardLiveResponse = {
  /** ISO timestamp — for "data is N seconds stale" display if needed. */
  asOf: string;
  today: {
    rounds: DashboardLiveRound[];
    stats: DashboardLiveStats;
  };
  /** Empty when nothing is wrong — UI hides the whole zone. */
  alerts: DashboardLiveAlert[];
  /** Empty when no rounds today have waitlist activity. */
  waitlist: DashboardLiveWaitlist[];
  weekAhead: DashboardLiveWeekAheadDay[];
};

// ---------------------------------------------------------------------------
// 5-second in-memory cache for GET /admin/dashboard/live.
//
// With ~30s client polling, the cache prevents the 6 refreshes-per-minute
// from hammering the DB while still giving each "minute" a few cache misses
// for live data. State is per-process — acceptable because each Vercel
// function instance handles its own slice of traffic and the data is
// cheap to recompute on miss.
//
// No invalidation hook: TTL-only. Operator-visible state changes (booking
// confirmed, round closed) become visible to the dashboard within 5s of
// the change — well below the human "is this live?" threshold.
// ---------------------------------------------------------------------------
const LIVE_CACHE_TTL_MS = 5_000;
let liveCache: { data: DashboardLiveResponse; expiresAt: number } | null = null;

async function computeDashboardLive(): Promise<DashboardLiveResponse> {
  const now = new Date();
  // Sequential queries — PGlite (test fixture) is single-connection. Prod
  // driver handles serial fine and the total wall time stays under 100ms
  // even on a few thousand rows. Parallelize if we ever measure regret.
  const rounds = await dashboardLiveRoundsToday(db, now);
  const stats = await dashboardLiveStats(db, now);
  const waitlistRows = await dashboardLiveWaitlist(db, now);
  const weekAhead = await dashboardLiveWeekAhead(db, now);
  return {
    asOf: now.toISOString(),
    today: {
      rounds: rounds.map((r) => ({
        roundInstanceId: r.roundInstanceId,
        label: r.label,
        startTime: r.startTime,
        endTime: r.endTime,
        capacity: r.capacity,
        taken: r.taken,
        heldCount: r.heldCount,
        pctFull: r.pctFull,
        isClosed: r.isClosed,
      })),
      stats: {
        revenueIls: stats.revenueIls,
        revenueDeltaPct: stats.revenueDeltaPct,
        bookingsCount: stats.bookingsCount,
        bookingsDelta: stats.bookingsDelta,
        activeHoldsCount: stats.activeHoldsCount,
        punchCardsSold: stats.punchCardsSold,
        punchCardsDelta: stats.punchCardsDelta,
      },
    },
    // Alerts intentionally empty until the application-layer detection lands
    // (payment_received_no_slot status, stuck-hold detection, full-round
    // waitlist threshold). Empty array → SPA hides the zone.
    alerts: [],
    waitlist: waitlistRows.map((w) => ({
      roundInstanceId: w.roundInstanceId,
      label: w.label,
      waitingCount: w.waitingCount,
      lastNotifiedAt: w.lastNotifiedAt,
    })),
    weekAhead: weekAhead.map((day) => ({
      date: day.date,
      rounds: day.rounds.map((r) => ({
        roundInstanceId: r.roundInstanceId,
        label: r.label,
        startTime: r.startTime,
        pctFull: r.pctFull,
        isClosed: r.isClosed,
      })),
    })),
  };
}

async function getCachedDashboardLive(): Promise<DashboardLiveResponse> {
  const now = Date.now();
  if (liveCache && liveCache.expiresAt > now) {
    return liveCache.data;
  }
  const data = await computeDashboardLive();
  liveCache = { data, expiresAt: now + LIVE_CACHE_TTL_MS };
  return data;
}

// Test seam — lets the route-level test suite reset the cache between
// assertions when it needs to (otherwise a 5s TTL leaks between tests).
export function _resetDashboardLiveCacheForTests(): void {
  liveCache = null;
}

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/admin/dashboard',
    { preHandler: requireRoleHook('admin', 'manager') },
    async () => ({ stats: await dashboardStats(db) }),
  );

  // Live operational view for the rounds-aware admin dashboard. Polled every
  // ~30s by the SPA; serves the data behind §11.1.1 of the rounds super-brief.
  // Real DB queries (step 2b) behind a 5s in-memory cache; alerts deferred
  // to a later step. Revenue stubbed (0, null) until step 3 ships pricing.
  fastify.get(
    '/admin/dashboard/live',
    { preHandler: requireRoleHook('admin', 'manager') },
    async (request): Promise<DashboardLiveResponse> => {
      const t0 = Date.now();
      const data = await getCachedDashboardLive();
      request.log.info(
        { ms: Date.now() - t0, rounds: data.today.rounds.length },
        '[admin dashboard live] served',
      );
      return data;
    },
  );

  // Re-engagement list: customers who hold a card but have not visited in 30 days.
  fastify.get(
    '/admin/reports/dormant',
    { preHandler: requireRoleHook('admin', 'manager') },
    async () => ({ customers: await dormantCustomers(db) }),
  );

  // Staff action log (who did what, when).
  fastify.get('/admin/actions', { preHandler: requireRoleHook('admin', 'manager') }, async () => ({
    actions: await listStaffActions(db),
  }));

  // Bulk re-sign every card's qr_token with the current envKeyResolver. Used
  // when the signing secret was rotated (or cards were minted under a foreign
  // env) and existing tokens fail HMAC verify even though the card rows
  // themselves are valid. Idempotent — a no-op on the second call. The card
  // identity (id, customer, serial, createdAt) is preserved; only the
  // signature and key_id are refreshed. Admin-only and rate-limited because
  // this iterates every active card row.
  fastify.post(
    '/admin/cards/re-mint-tokens',
    {
      preHandler: requireRoleHook('admin'),
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    },
    async (request) => {
      const result = await reMintAllPunchCardTokens(db, envKeyResolver);
      request.log.info({ ...result }, '[admin re-mint] bulk re-mint complete');
      await logStaffAction(db, {
        ...(request.user && { staffId: request.user.id }),
        action: 'other',
        summary: `Re-minted qr_token on ${result.updated} of ${result.scanned} cards`,
      });
      return result;
    },
  );
};
