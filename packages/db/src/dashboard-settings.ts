// Read + update for the singleton dashboard_settings row. Pattern mirrors
// packages/db/src/card-settings.ts: getSettings returns the row (creating
// the singleton if a misconfigured DB is missing it), updateSettings
// validates the patch and persists changed fields only.

import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { dashboardSettings, type DashboardSettingsRow } from './schema/dashboard-settings';

type AnyPgDatabase = PgDatabase<any, any, any>;

// Widget keys the SPA knows how to render. Anything else is rejected at
// update time so a typo can't silently hide every widget.
export const DASHBOARD_WIDGET_KEYS = [
  'rounds_today',
  'stats_today',
  'alerts',
  'waitlist',
  'week_ahead',
] as const;
export type DashboardWidgetKey = (typeof DASHBOARD_WIDGET_KEYS)[number];

export type UpdateDashboardSettingsInput = {
  refreshIntervalSeconds?: number;
  showRevenue?: boolean;
  showWeekAhead?: boolean;
  capacityWarningPct?: number;
  capacityDangerPct?: number;
  widgetsOrder?: string[];
};

export type DashboardSettingsValidationError =
  | { code: 'refresh_interval_out_of_range'; min: number; max: number }
  | { code: 'capacity_warning_out_of_range'; min: number; max: number }
  | { code: 'capacity_danger_out_of_range'; min: number; max: number }
  | { code: 'capacity_warning_above_danger' }
  | { code: 'widgets_order_unknown_key'; key: string }
  | { code: 'widgets_order_duplicate_key'; key: string };

const REFRESH_INTERVAL_MIN_SEC = 5;
const REFRESH_INTERVAL_MAX_SEC = 3600;

/**
 * Read the singleton settings row. If the row is missing (a misconfigured
 * env, or a future migration that drops + recreates) we insert the
 * default row so callers always get a usable response.
 */
export const getDashboardSettings = async (
  db: AnyPgDatabase,
): Promise<DashboardSettingsRow> => {
  const rows = await db.select().from(dashboardSettings).limit(1);
  const existing = rows[0];
  if (existing) return existing;

  // Self-heal: the migration seeds the row, but production hand-edits or
  // a hot-restored backup might lose it. Insert default and return.
  const inserted = await db
    .insert(dashboardSettings)
    .values({ id: 1 })
    .returning();
  if (!inserted[0]) throw new Error('[dashboard-settings] failed to self-heal singleton');
  return inserted[0];
};

/**
 * Validate an update patch. Returns an error code on the first problem
 * found, or null when the patch is acceptable. Pure — no DB calls.
 *
 * Validation rules:
 *   - refresh interval: REFRESH_INTERVAL_MIN_SEC..MAX_SEC
 *   - capacity percentages: 0..100
 *   - warning <= danger (after applying the patch)
 *   - widget keys: every entry must be in DASHBOARD_WIDGET_KEYS
 *   - widget keys: no duplicates
 */
export const validateDashboardSettingsPatch = (
  current: DashboardSettingsRow,
  patch: UpdateDashboardSettingsInput,
): DashboardSettingsValidationError | null => {
  if (patch.refreshIntervalSeconds !== undefined) {
    if (
      !Number.isInteger(patch.refreshIntervalSeconds) ||
      patch.refreshIntervalSeconds < REFRESH_INTERVAL_MIN_SEC ||
      patch.refreshIntervalSeconds > REFRESH_INTERVAL_MAX_SEC
    ) {
      return {
        code: 'refresh_interval_out_of_range',
        min: REFRESH_INTERVAL_MIN_SEC,
        max: REFRESH_INTERVAL_MAX_SEC,
      };
    }
  }
  if (patch.capacityWarningPct !== undefined) {
    if (
      !Number.isInteger(patch.capacityWarningPct) ||
      patch.capacityWarningPct < 0 ||
      patch.capacityWarningPct > 100
    ) {
      return { code: 'capacity_warning_out_of_range', min: 0, max: 100 };
    }
  }
  if (patch.capacityDangerPct !== undefined) {
    if (
      !Number.isInteger(patch.capacityDangerPct) ||
      patch.capacityDangerPct < 0 ||
      patch.capacityDangerPct > 100
    ) {
      return { code: 'capacity_danger_out_of_range', min: 0, max: 100 };
    }
  }
  const warning = patch.capacityWarningPct ?? current.capacityWarningPct;
  const danger = patch.capacityDangerPct ?? current.capacityDangerPct;
  if (warning > danger) {
    return { code: 'capacity_warning_above_danger' };
  }
  if (patch.widgetsOrder !== undefined) {
    const seen = new Set<string>();
    for (const key of patch.widgetsOrder) {
      if (!(DASHBOARD_WIDGET_KEYS as readonly string[]).includes(key)) {
        return { code: 'widgets_order_unknown_key', key };
      }
      if (seen.has(key)) {
        return { code: 'widgets_order_duplicate_key', key };
      }
      seen.add(key);
    }
  }
  return null;
};

export type UpdateDashboardSettingsResult =
  | { ok: true; row: DashboardSettingsRow; diff: Record<string, [unknown, unknown]> }
  | { ok: false; error: DashboardSettingsValidationError }
  | { ok: true; row: DashboardSettingsRow; diff: Record<string, never>; noChanges: true };

/**
 * Validate + persist a patch. Returns the updated row and the diff
 * (old → new) for every field that actually changed, so an audit log
 * can describe what moved. Empty patches (no field given, or every
 * value identical to current) return `noChanges: true` and a no-op
 * empty diff — caller can skip logging.
 */
export const updateDashboardSettings = async (
  db: AnyPgDatabase,
  patch: UpdateDashboardSettingsInput,
): Promise<UpdateDashboardSettingsResult> => {
  const current = await getDashboardSettings(db);
  const validationError = validateDashboardSettingsPatch(current, patch);
  if (validationError) return { ok: false, error: validationError };

  const diff: Record<string, [unknown, unknown]> = {};
  const nextValues: Partial<DashboardSettingsRow> = {};

  if (patch.refreshIntervalSeconds !== undefined && patch.refreshIntervalSeconds !== current.refreshIntervalSeconds) {
    diff.refreshIntervalSeconds = [current.refreshIntervalSeconds, patch.refreshIntervalSeconds];
    nextValues.refreshIntervalSeconds = patch.refreshIntervalSeconds;
  }
  if (patch.showRevenue !== undefined && patch.showRevenue !== current.showRevenue) {
    diff.showRevenue = [current.showRevenue, patch.showRevenue];
    nextValues.showRevenue = patch.showRevenue;
  }
  if (patch.showWeekAhead !== undefined && patch.showWeekAhead !== current.showWeekAhead) {
    diff.showWeekAhead = [current.showWeekAhead, patch.showWeekAhead];
    nextValues.showWeekAhead = patch.showWeekAhead;
  }
  if (patch.capacityWarningPct !== undefined && patch.capacityWarningPct !== current.capacityWarningPct) {
    diff.capacityWarningPct = [current.capacityWarningPct, patch.capacityWarningPct];
    nextValues.capacityWarningPct = patch.capacityWarningPct;
  }
  if (patch.capacityDangerPct !== undefined && patch.capacityDangerPct !== current.capacityDangerPct) {
    diff.capacityDangerPct = [current.capacityDangerPct, patch.capacityDangerPct];
    nextValues.capacityDangerPct = patch.capacityDangerPct;
  }
  if (patch.widgetsOrder !== undefined) {
    const prev = current.widgetsOrder as string[];
    const next = patch.widgetsOrder;
    const changed = prev.length !== next.length || prev.some((v, i) => v !== next[i]);
    if (changed) {
      diff.widgetsOrder = [prev, next];
      nextValues.widgetsOrder = next;
    }
  }

  if (Object.keys(diff).length === 0) {
    return { ok: true, row: current, diff: {}, noChanges: true };
  }

  const updated = await db
    .update(dashboardSettings)
    .set({ ...nextValues, updatedAt: new Date() })
    .where(eq(dashboardSettings.id, 1))
    .returning();
  if (!updated[0]) throw new Error('[dashboard-settings] update returned no row');
  return { ok: true, row: updated[0], diff };
};

// ---------------------------------------------------------------------------
// Privacy gate — pure function so it's trivial to test without a DB
// ---------------------------------------------------------------------------

export type DashboardLiveStatsWithOptionalRevenue = {
  revenueIls?: number;
  revenueDeltaPct?: number | null;
  bookingsCount: number;
  bookingsDelta: number | null;
  activeHoldsCount: number;
  punchCardsSold: number;
  punchCardsDelta: number | null;
};

export type DashboardLiveStatsAllFields = {
  revenueIls: number;
  revenueDeltaPct: number | null;
  bookingsCount: number;
  bookingsDelta: number | null;
  activeHoldsCount: number;
  punchCardsSold: number;
  punchCardsDelta: number | null;
};

/**
 * Strip revenue fields from the stats block when either:
 *   - settings.showRevenue is false (operator chose to hide revenue), OR
 *   - the requesting user's role is below 'manager' (defence in depth —
 *     the endpoint already gates at admin/manager, but if a future
 *     change opens it to other roles, revenue stays gated)
 *
 * Pure function; never throws. Returns a new object with the same shape
 * minus the revenue fields when they should be hidden.
 */
export const applyRevenuePrivacyGate = (
  stats: DashboardLiveStatsAllFields,
  opts: { showRevenue: boolean; requesterRole: string },
): DashboardLiveStatsWithOptionalRevenue => {
  const allowed = opts.showRevenue && (opts.requesterRole === 'admin' || opts.requesterRole === 'manager');
  if (allowed) return stats;
  // Strip revenue fields by destructuring them out.
  const { revenueIls: _revenueIls, revenueDeltaPct: _revenueDeltaPct, ...rest } = stats;
  return rest;
};
