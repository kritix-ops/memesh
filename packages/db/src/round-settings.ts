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
const BOOKING_HORIZON_MIN = 1;
const BOOKING_HORIZON_MAX = 365;
const MARKING_GRACE_MIN = 0;
const MARKING_GRACE_MAX = 240;

export type UpdateRoundSettingsInput = {
  roundsEnabled?: boolean;
  holdTtlMinutes?: number;
  cancellationWindowHours?: number;
  claimWindowMinutes?: number;
  activeHoursStart?: number;
  activeHoursEnd?: number;
  reminderOffsets?: number[];
  closingTime?: string;
  skipLastRoundReminder?: boolean;
  allowOverCapacityWalkIn?: boolean;
  warnUpcomingReservationAtDoor?: boolean;
  bookingHorizonDays?: number;
  markingGraceMinutes?: number;
};

export type RoundSettingsValidationError =
  | { code: 'hold_ttl_out_of_range'; min: number; max: number }
  | { code: 'cancellation_window_out_of_range'; min: number; max: number }
  | { code: 'claim_window_out_of_range'; min: number; max: number }
  | { code: 'active_hours_out_of_range'; min: number; max: number }
  | { code: 'booking_horizon_out_of_range'; min: number; max: number }
  | { code: 'marking_grace_out_of_range'; min: number; max: number }
  | { code: 'reminder_offsets_invalid' }
  | { code: 'closing_time_invalid' };

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const REMINDER_OFFSET_MAX = 240;

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
  if (patch.bookingHorizonDays !== undefined) {
    if (
      !Number.isInteger(patch.bookingHorizonDays) ||
      patch.bookingHorizonDays < BOOKING_HORIZON_MIN ||
      patch.bookingHorizonDays > BOOKING_HORIZON_MAX
    ) {
      return { code: 'booking_horizon_out_of_range', min: BOOKING_HORIZON_MIN, max: BOOKING_HORIZON_MAX };
    }
  }
  if (patch.markingGraceMinutes !== undefined) {
    if (
      !Number.isInteger(patch.markingGraceMinutes) ||
      patch.markingGraceMinutes < MARKING_GRACE_MIN ||
      patch.markingGraceMinutes > MARKING_GRACE_MAX
    ) {
      return { code: 'marking_grace_out_of_range', min: MARKING_GRACE_MIN, max: MARKING_GRACE_MAX };
    }
  }
  if (patch.reminderOffsets !== undefined) {
    // Empty array = reminders disabled. Up to 5 offsets, each 1-240 minutes.
    const a = patch.reminderOffsets;
    if (
      !Array.isArray(a) ||
      a.length > 5 ||
      a.some((n) => !Number.isInteger(n) || n < 1 || n > REMINDER_OFFSET_MAX)
    ) {
      return { code: 'reminder_offsets_invalid' };
    }
  }
  if (patch.closingTime !== undefined && !HHMM_RE.test(patch.closingTime)) {
    return { code: 'closing_time_invalid' };
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

  if (patch.roundsEnabled !== undefined && patch.roundsEnabled !== current.roundsEnabled) {
    diff.roundsEnabled = [current.roundsEnabled, patch.roundsEnabled];
    next.roundsEnabled = patch.roundsEnabled;
  }
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
  if (
    patch.reminderOffsets !== undefined &&
    JSON.stringify(patch.reminderOffsets) !== JSON.stringify(current.reminderOffsets)
  ) {
    diff.reminderOffsets = [current.reminderOffsets, patch.reminderOffsets];
    next.reminderOffsets = patch.reminderOffsets;
  }
  // DB stores time as 'HH:MM:SS'; compare on the 'HH:MM' the admin sends.
  if (patch.closingTime !== undefined && patch.closingTime !== current.closingTime.slice(0, 5)) {
    diff.closingTime = [current.closingTime, patch.closingTime];
    next.closingTime = patch.closingTime;
  }
  if (
    patch.skipLastRoundReminder !== undefined &&
    patch.skipLastRoundReminder !== current.skipLastRoundReminder
  ) {
    diff.skipLastRoundReminder = [current.skipLastRoundReminder, patch.skipLastRoundReminder];
    next.skipLastRoundReminder = patch.skipLastRoundReminder;
  }
  if (
    patch.allowOverCapacityWalkIn !== undefined &&
    patch.allowOverCapacityWalkIn !== current.allowOverCapacityWalkIn
  ) {
    diff.allowOverCapacityWalkIn = [current.allowOverCapacityWalkIn, patch.allowOverCapacityWalkIn];
    next.allowOverCapacityWalkIn = patch.allowOverCapacityWalkIn;
  }
  if (
    patch.warnUpcomingReservationAtDoor !== undefined &&
    patch.warnUpcomingReservationAtDoor !== current.warnUpcomingReservationAtDoor
  ) {
    diff.warnUpcomingReservationAtDoor = [
      current.warnUpcomingReservationAtDoor,
      patch.warnUpcomingReservationAtDoor,
    ];
    next.warnUpcomingReservationAtDoor = patch.warnUpcomingReservationAtDoor;
  }
  if (
    patch.bookingHorizonDays !== undefined &&
    patch.bookingHorizonDays !== current.bookingHorizonDays
  ) {
    diff.bookingHorizonDays = [current.bookingHorizonDays, patch.bookingHorizonDays];
    next.bookingHorizonDays = patch.bookingHorizonDays;
  }
  if (
    patch.markingGraceMinutes !== undefined &&
    patch.markingGraceMinutes !== current.markingGraceMinutes
  ) {
    diff.markingGraceMinutes = [current.markingGraceMinutes, patch.markingGraceMinutes];
    next.markingGraceMinutes = patch.markingGraceMinutes;
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
