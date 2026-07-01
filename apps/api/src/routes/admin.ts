import {
  applyRevenuePrivacyGate,
  dashboardLiveRoundsToday,
  dashboardLiveStats,
  dashboardLiveWaitlist,
  dashboardLiveWeekAhead,
  dashboardStats,
  db,
  dormantCustomers,
  getDashboardSettings,
  listStaffActions,
  logStaffAction,
  reMintAllPunchCardTokens,
  updateDashboardSettings,
  type UpdateDashboardSettingsInput,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';

// ---------------------------------------------------------------------------
// Rounds-aware live dashboard response shape. The admin SPA mirrors this in
// its own lib/api/admin.ts (same pattern as the existing DashboardStats type).
//
// History:
//   Step 1 (PR #22): stubbed empty values, no DB reads.
//   Step 2b (PR #25): real DB queries behind a 5s in-memory cache.
//   Step 3 (this PR): revenue privacy gate keyed on dashboard_settings.show_revenue.
//     revenueIls + revenueDeltaPct are now optional — absent from the
//     response when the setting is off OR the requester is below manager.
// See _plans/2026-06-30-admin-rounds-dashboard.md for the full contract.
// ---------------------------------------------------------------------------

export type DashboardLiveStats = {
  /** Omitted when dashboard_settings.show_revenue=false or requester role < manager. */
  revenueIls?: number;
  /** Day-over-day delta at the same hour. null when yesterday's data point doesn't exist; omitted under same conditions as revenueIls. */
  revenueDeltaPct?: number | null;
  bookingsCount: number;
  bookingsDelta: number | null;
  activeHoldsCount: number;
  punchCardsSold: number;
  punchCardsDelta: number | null;
  /** Paid additional companions on today's confirmed bookings. */
  companionsCount: number;
  companionsDelta: number | null;
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

// Display config the SPA needs to render the dashboard the way the operator
// configured it (Super Brief §15.3). The client must not hardcode these
// thresholds or the refresh cadence. `showRevenue` is deliberately absent:
// revenue visibility is enforced server-side by stripping the revenue fields,
// and the client infers "hidden" from `revenueIls === undefined`.
export type DashboardLiveSettings = {
  /** Client auto-refresh cadence, in seconds. */
  refreshIntervalSeconds: number;
  /** Whether the 7-day forward grid renders at all. */
  showWeekAhead: boolean;
  /** Occupancy percentage at which a round tile turns amber. */
  capacityWarningPct: number;
  /** Occupancy percentage at which a round tile turns red. */
  capacityDangerPct: number;
  /** Ordered list of visible dashboard zones; a key omitted here hides that zone. */
  widgetsOrder: string[];
};

export type DashboardLiveResponse = {
  /** ISO timestamp — for "data is N seconds stale" display if needed. */
  asOf: string;
  /** Display config from dashboard_settings — thresholds, cadence, week-grid visibility. */
  settings: DashboardLiveSettings;
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
// Cache holds the FULL pre-gate response plus the settings snapshot used
// to apply the per-request privacy gate. Bundling settings inside the
// cache means a setting toggle takes up to 5s to take effect (acceptable
// — admin actions don't need sub-second feedback), and avoids an extra
// settings query per request.
type CachedDashboard = {
  /** Full response including revenue fields — privacy gate is applied per request. */
  data: DashboardLiveResponse;
  /** Snapshot of dashboard_settings used when this cache entry was built. */
  settings: { showRevenue: boolean };
  expiresAt: number;
};
let liveCache: CachedDashboard | null = null;

async function computeDashboardLive(): Promise<Omit<CachedDashboard, 'expiresAt'>> {
  const now = new Date();
  // Sequential queries — PGlite (test fixture) is single-connection. Prod
  // driver handles serial fine and the total wall time stays under 100ms
  // even on a few thousand rows. Parallelize if we ever measure regret.
  const settings = await getDashboardSettings(db);
  const rounds = await dashboardLiveRoundsToday(db, now);
  const stats = await dashboardLiveStats(db, now);
  const waitlistRows = await dashboardLiveWaitlist(db, now);
  const weekAhead = await dashboardLiveWeekAhead(db, now);
  return {
    data: {
      asOf: now.toISOString(),
      settings: {
        refreshIntervalSeconds: settings.refreshIntervalSeconds,
        showWeekAhead: settings.showWeekAhead,
        capacityWarningPct: settings.capacityWarningPct,
        capacityDangerPct: settings.capacityDangerPct,
        widgetsOrder: settings.widgetsOrder as string[],
      },
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
          // Revenue fields included here; route handler applies privacy
          // gate per request before responding.
          revenueIls: stats.revenueIls,
          revenueDeltaPct: stats.revenueDeltaPct,
          bookingsCount: stats.bookingsCount,
          bookingsDelta: stats.bookingsDelta,
          activeHoldsCount: stats.activeHoldsCount,
          punchCardsSold: stats.punchCardsSold,
          punchCardsDelta: stats.punchCardsDelta,
          companionsCount: stats.companionsCount,
          companionsDelta: stats.companionsDelta,
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
    },
    settings: { showRevenue: settings.showRevenue },
  };
}

async function getCachedDashboardLive(): Promise<CachedDashboard> {
  const now = Date.now();
  if (liveCache && liveCache.expiresAt > now) {
    return liveCache;
  }
  const computed = await computeDashboardLive();
  liveCache = { ...computed, expiresAt: now + LIVE_CACHE_TTL_MS };
  return liveCache;
}

/**
 * Strip the cached response's revenue fields based on the requesting user's
 * role and the current showRevenue setting. Returns a new object — never
 * mutates the cached data.
 */
function applyPrivacyGateToResponse(
  cached: CachedDashboard,
  requesterRole: string,
): DashboardLiveResponse {
  const gatedStats = applyRevenuePrivacyGate(
    {
      revenueIls: cached.data.today.stats.revenueIls ?? 0,
      revenueDeltaPct: cached.data.today.stats.revenueDeltaPct ?? null,
      bookingsCount: cached.data.today.stats.bookingsCount,
      bookingsDelta: cached.data.today.stats.bookingsDelta,
      activeHoldsCount: cached.data.today.stats.activeHoldsCount,
      punchCardsSold: cached.data.today.stats.punchCardsSold,
      punchCardsDelta: cached.data.today.stats.punchCardsDelta,
      companionsCount: cached.data.today.stats.companionsCount,
      companionsDelta: cached.data.today.stats.companionsDelta,
    },
    { showRevenue: cached.settings.showRevenue, requesterRole },
  );
  return {
    ...cached.data,
    today: {
      ...cached.data.today,
      stats: gatedStats,
    },
  };
}

// Test seam — lets the route-level test suite reset the cache between
// assertions when it needs to (otherwise a 5s TTL leaks between tests).
export function _resetDashboardLiveCacheForTests(): void {
  liveCache = null;
}

// PATCH body for /admin/dashboard/settings. Shape + primitive types only —
// range and cross-field rules (warning <= danger, known widget keys, refresh
// bounds) live in the DB helper's validateDashboardSettingsPatch and surface
// as 400s. `.strict()` rejects unknown keys so a typo fails loudly.
const dashboardSettingsUpdateSchema = z
  .object({
    refreshIntervalSeconds: z.number().int(),
    showRevenue: z.boolean(),
    showWeekAhead: z.boolean(),
    capacityWarningPct: z.number().int(),
    capacityDangerPct: z.number().int(),
    widgetsOrder: z.array(z.string()),
  })
  .partial()
  .strict();

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/admin/dashboard',
    { preHandler: requireRoleHook('admin', 'manager') },
    async () => ({ stats: await dashboardStats(db) }),
  );

  // Live operational view for the rounds-aware admin dashboard. Polled every
  // ~30s by the SPA; serves the data behind §11.1.1 of the rounds super-brief.
  // Real DB queries (step 2b) behind a 5s in-memory cache; alerts deferred
  // to a later step. Revenue privacy gate (step 3) strips revenue fields
  // per-request based on dashboard_settings.show_revenue + requester role.
  fastify.get(
    '/admin/dashboard/live',
    { preHandler: requireRoleHook('admin', 'manager') },
    async (request): Promise<DashboardLiveResponse> => {
      const t0 = Date.now();
      const cached = await getCachedDashboardLive();
      const requesterRole = request.user?.role ?? 'unknown';
      const response = applyPrivacyGateToResponse(cached, requesterRole);
      request.log.info(
        {
          ms: Date.now() - t0,
          rounds: response.today.rounds.length,
          revenueShown: response.today.stats.revenueIls !== undefined,
        },
        '[admin dashboard live] served',
      );
      return response;
    },
  );

  // Full dashboard settings — the admin-only edit surface behind the "דשבורד"
  // section of the Settings tab. Returns every field, including showRevenue and
  // widgetsOrder that the live endpoint deliberately does not expose.
  fastify.get(
    '/admin/dashboard/settings',
    { preHandler: requireRoleHook('admin') },
    async (request) => {
      const settings = await getDashboardSettings(db);
      request.log.info('[dashboard-settings get]');
      return { settings };
    },
  );

  // Update dashboard settings. Admin-only, partial body. Range + cross-field
  // validation lives in the DB helper; every rejection is a 400. On success we
  // drop the live cache so the change shows on the next dashboard poll rather
  // than waiting out the 5s TTL.
  fastify.patch(
    '/admin/dashboard/settings',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const parsed = dashboardSettingsUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      // Build the patch with only the fields actually present. Copying
      // parsed.data wholesale would carry `| undefined` on every key, which
      // exactOptionalPropertyTypes rejects against the exact-optional input.
      const p = parsed.data;
      const patch: UpdateDashboardSettingsInput = {};
      if (p.refreshIntervalSeconds !== undefined) patch.refreshIntervalSeconds = p.refreshIntervalSeconds;
      if (p.showRevenue !== undefined) patch.showRevenue = p.showRevenue;
      if (p.showWeekAhead !== undefined) patch.showWeekAhead = p.showWeekAhead;
      if (p.capacityWarningPct !== undefined) patch.capacityWarningPct = p.capacityWarningPct;
      if (p.capacityDangerPct !== undefined) patch.capacityDangerPct = p.capacityDangerPct;
      if (p.widgetsOrder !== undefined) patch.widgetsOrder = p.widgetsOrder;
      const result = await updateDashboardSettings(db, patch);
      if (!result.ok) {
        request.log.info({ error: result.error }, '[dashboard-settings update] rejected');
        return reply.code(400).send({ error: result.error.code });
      }
      liveCache = null;
      request.log.info(
        { diff: result.diff, staffId: request.user?.id },
        '[dashboard-settings update]',
      );
      return { settings: result.row, diff: result.diff };
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
