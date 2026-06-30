import {
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

const emptyLiveStats: DashboardLiveStats = {
  revenueIls: 0,
  revenueDeltaPct: null,
  bookingsCount: 0,
  bookingsDelta: null,
  activeHoldsCount: 0,
  punchCardsSold: 0,
  punchCardsDelta: null,
};

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/admin/dashboard',
    { preHandler: requireRoleHook('admin', 'manager') },
    async () => ({ stats: await dashboardStats(db) }),
  );

  // Live operational view for the rounds-aware admin dashboard. Polled every
  // ~30s by the SPA; serves the data behind §11.1.1 of the rounds super-brief.
  // Step 1 scaffold returns an empty-but-typed body so the SPA can be built
  // against the contract while step 2 wires real DB queries.
  fastify.get(
    '/admin/dashboard/live',
    { preHandler: requireRoleHook('admin', 'manager') },
    async (): Promise<DashboardLiveResponse> => ({
      asOf: new Date().toISOString(),
      today: { rounds: [], stats: emptyLiveStats },
      alerts: [],
      waitlist: [],
      weekAhead: [],
    }),
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
