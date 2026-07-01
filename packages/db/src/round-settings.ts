// Read + update for the singleton round_settings row (super-brief §15 runtime
// knobs the purchase/cancel/waitlist flow reads). Mirrors dashboard-settings.ts:
// self-healing get, pure validation, persist changed fields only.

import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { roundSettings, type RoundSettingsRow } from './schema/round-settings';

type AnyPgDatabase = PgDatabase<any, any, any>;

const HOLD_TTL_MIN = 1;
const HOLD_TTL_MAX = 240;
const CANCEL_WINDOW_MIN = 0;
const CANCEL_WINDOW_MAX = 720; // 30 days
const CLAIM_WINDOW_MIN = 1;
const CLAIM_WINDOW_MAX = 1440; // 24h
const ACTIVE_HOUR_MIN = 0;
const ACTIVE_HOUR_MAX = 23;

export type UpdateRoundSettingsInput = {
  holdTtlMinutes?: number;
  cancellationWindowHours?: number;
  claimWindowMinutes?: number;
  activeHoursStart?: number;
  activeHoursEnd?: number;
};

export type RoundSettingsValidationError =
  | { code: 'hold_ttl_out_of_range'; min: number; max: number }
  | { code: 'cancellation_window_out_of_range'; min: number; max: number }
  | { code: 'claim_window_out_of_range'; min: number; max: number }
  | { code: 'active_hours_out_of_range'; min: number; max: number };

/** Read the singleton row, self-healing the seed if a misconfigured DB lost it. */
export const getRoundSettings = async (db: AnyPgDatabase): Promise<RoundSettingsRow> => {
  const rows = await db.select().from(roundSettings).limit(1);
  const existing = rows[0];
  if (existing) return existing;
  const inserted = await db.insert(roundSettings).values({ id: 1 }).returning();
  if (!inserted[0]) throw new Error('[round-settings] failed to self-heal singleton');
  return inserted[0];
};

/** Validate a patch. Returns the first problem or null. Pure. */
export const validateRoundSettingsPatch = (
  patch: UpdateRoundSettingsInput,
): RoundSettingsValidationError | null => {
  if (patch.holdTtlMinutes !== undefined) {
    if (
      !Number.isInteger(patch.holdTtlMinutes) ||
      patch.holdTtlMinutes < HOLD_TTL_MIN ||
      patch.holdTtlMinutes > HOLD_TTL_MAX
    ) {
      return { code: 'hold_ttl_out_of_range', min: HOLD_TTL_MIN, max: HOLD_TTL_MAX };
    }
  }
  if (patch.cancellationWindowHours !== undefined) {
    if (
      !Number.isInteger(patch.cancellationWindowHours) ||
      patch.cancellationWindowHours < CANCEL_WINDOW_MIN ||
      patch.cancellationWindowHours > CANCEL_WINDOW_MAX
    ) {
      return { code: 'cancellation_window_out_of_range', min: CANCEL_WINDOW_MIN, max: CANCEL_WINDOW_MAX };
    }
  }
  if (patch.claimWindowMinutes !== undefined) {
    if (
      !Number.isInteger(patch.claimWindowMinutes) ||
      patch.claimWindowMinutes < CLAIM_WINDOW_MIN ||
      patch.claimWindowMinutes > CLAIM_WINDOW_MAX
    ) {
      return { code: 'claim_window_out_of_range', min: CLAIM_WINDOW_MIN, max: CLAIM_WINDOW_MAX };
    }
  }
  for (const h of [patch.activeHoursStart, patch.activeHoursEnd]) {
    if (h !== undefined && (!Number.isInteger(h) || h < ACTIVE_HOUR_MIN || h > ACTIVE_HOUR_MAX)) {
      return { code: 'active_hours_out_of_range', min: ACTIVE_HOUR_MIN, max: ACTIVE_HOUR_MAX };
    }
  }
  return null;
};

export type UpdateRoundSettingsResult =
  | { ok: true; row: RoundSettingsRow; diff: Record<string, [unknown, unknown]> }
  | { ok: false; error: RoundSettingsValidationError };

/** Validate + persist a patch. Returns the row + a diff of changed fields. */
export const updateRoundSettings = async (
  db: AnyPgDatabase,
  patch: UpdateRoundSettingsInput,
): Promise<UpdateRoundSettingsResult> => {
  const error = validateRoundSettingsPatch(patch);
  if (error) return { ok: false, error };

  const current = await getRoundSettings(db);
  const diff: Record<string, [unknown, unknown]> = {};
  const next: Partial<RoundSettingsRow> = {};

  if (patch.holdTtlMinutes !== undefined && patch.holdTtlMinutes !== current.holdTtlMinutes) {
    diff.holdTtlMinutes = [current.holdTtlMinutes, patch.holdTtlMinutes];
    next.holdTtlMinutes = patch.holdTtlMinutes;
  }
  if (
    patch.cancellationWindowHours !== undefined &&
    patch.cancellationWindowHours !== current.cancellationWindowHours
  ) {
    diff.cancellationWindowHours = [current.cancellationWindowHours, patch.cancellationWindowHours];
    next.cancellationWindowHours = patch.cancellationWindowHours;
  }
  if (patch.claimWindowMinutes !== undefined && patch.claimWindowMinutes !== current.claimWindowMinutes) {
    diff.claimWindowMinutes = [current.claimWindowMinutes, patch.claimWindowMinutes];
    next.claimWindowMinutes = patch.claimWindowMinutes;
  }
  if (patch.activeHoursStart !== undefined && patch.activeHoursStart !== current.activeHoursStart) {
    diff.activeHoursStart = [current.activeHoursStart, patch.activeHoursStart];
    next.activeHoursStart = patch.activeHoursStart;
  }
  if (patch.activeHoursEnd !== undefined && patch.activeHoursEnd !== current.activeHoursEnd) {
    diff.activeHoursEnd = [current.activeHoursEnd, patch.activeHoursEnd];
    next.activeHoursEnd = patch.activeHoursEnd;
  }

  if (Object.keys(diff).length === 0) return { ok: true, row: current, diff: {} };

  const updated = await db
    .update(roundSettings)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(roundSettings.id, 1))
    .returning();
  if (!updated[0]) throw new Error('[round-settings] update returned no row');
  return { ok: true, row: updated[0], diff };
};
