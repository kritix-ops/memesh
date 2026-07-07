// Schedule rules for when the rounds system applies (plan
// 2026-07-02-round-schedule-rules): per-date / date-range / recurring-weekday
// rules with time windows and a per-rule outside-behavior (free_play |
// closed). Replaces the short-lived round_off_dates. A round is offered on a
// ruled date only when it fits ENTIRELY inside one of the rule's windows
// (Yoav: "must fit entirely"). Resolution when several rules match:
// single-date > bounded range > recurring; ties go to the most recently
// updated rule. One winner — rules never merge, so the admin can always
// predict what a day does.

import { asc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  roundInstances,
  roundScheduleRules,
  rounds,
  type RoundScheduleRule,
  type ScheduleWindow,
} from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_WINDOWS = 8;
const NOTE_MAX = 120;

export type ScheduleRuleInput = {
  /** YYYY-MM-DD. Required unless weekdayMask is set. */
  dateFrom?: string | null;
  /** YYYY-MM-DD. Requires dateFrom; >= dateFrom. Same as dateFrom = single date. */
  dateTo?: string | null;
  /** Bit 0 = Sunday … bit 6 = Saturday; 1..127. Null = every weekday in range. */
  weekdayMask?: number | null;
  /** Windows in which rounds run. Empty = no rounds on matched days. */
  windows: ScheduleWindow[];
  outside: 'free_play' | 'closed';
  note?: string | null;
};

export type ScheduleRuleValidationError =
  | { code: 'scope_required' }
  | { code: 'date_invalid' }
  | { code: 'date_range_inverted' }
  | { code: 'weekday_mask_out_of_range' }
  | { code: 'window_time_invalid' }
  | { code: 'window_end_not_after_start' }
  | { code: 'windows_overlap' }
  | { code: 'too_many_windows' }
  | { code: 'note_too_long' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a rule input. Returns the first problem or null. Pure. */
export const validateScheduleRule = (input: ScheduleRuleInput): ScheduleRuleValidationError | null => {
  const hasDate = input.dateFrom != null && input.dateFrom !== '';
  const hasMask = input.weekdayMask != null;
  if (!hasDate && !hasMask) return { code: 'scope_required' };
  if (hasDate && !DATE_RE.test(input.dateFrom!)) return { code: 'date_invalid' };
  if (input.dateTo != null && input.dateTo !== '') {
    if (!hasDate) return { code: 'scope_required' };
    if (!DATE_RE.test(input.dateTo)) return { code: 'date_invalid' };
    if (input.dateTo < input.dateFrom!) return { code: 'date_range_inverted' };
  }
  if (hasMask && (!Number.isInteger(input.weekdayMask) || input.weekdayMask! < 1 || input.weekdayMask! > 127)) {
    return { code: 'weekday_mask_out_of_range' };
  }
  if (input.windows.length > MAX_WINDOWS) return { code: 'too_many_windows' };
  for (const w of input.windows) {
    if (!HHMM_RE.test(w.start) || !HHMM_RE.test(w.end)) return { code: 'window_time_invalid' };
    if (w.end <= w.start) return { code: 'window_end_not_after_start' };
  }
  const sorted = [...input.windows].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return { code: 'windows_overlap' };
  }
  if (input.note != null && input.note.length > NOTE_MAX) return { code: 'note_too_long' };
  return null;
};

export type CreateScheduleRuleResult =
  | { ok: true; rule: RoundScheduleRule }
  | { ok: false; error: ScheduleRuleValidationError };

export const createScheduleRule = async (
  db: AnyPgDatabase,
  input: ScheduleRuleInput,
  now: Date = new Date(),
): Promise<CreateScheduleRuleResult> => {
  const error = validateScheduleRule(input);
  if (error) return { ok: false, error };
  const windows = [...input.windows].sort((a, b) => a.start.localeCompare(b.start));
  const inserted = await db
    .insert(roundScheduleRules)
    .values({
      dateFrom: input.dateFrom ?? null,
      dateTo: input.dateTo ?? null,
      weekdayMask: input.weekdayMask ?? null,
      windows,
      outside: input.outside,
      note: input.note?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const rule = inserted[0];
  if (!rule) throw new Error('[rounds-schedule] insert returned no row');
  return { ok: true, rule };
};

export const listScheduleRules = async (db: AnyPgDatabase): Promise<RoundScheduleRule[]> => {
  return db.select().from(roundScheduleRules).orderBy(asc(roundScheduleRules.createdAt));
};

export const deleteScheduleRule = async (db: AnyPgDatabase, id: string): Promise<{ ok: boolean }> => {
  const deleted = await db
    .delete(roundScheduleRules)
    .where(eq(roundScheduleRules.id, id))
    .returning({ id: roundScheduleRules.id });
  return { ok: deleted.length > 0 };
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedSchedule {
  windows: ScheduleWindow[];
  outside: 'free_play' | 'closed';
  /** Free-play open/close bounds ("HH:MM"), or null for open-all-day. Only
   *  meaningful when outside === 'free_play' (special hours / Friday early-close). */
  openFrom: string | null;
  openUntil: string | null;
  ruleId: string;
}

/** Local weekday (0 = Sunday) of a YYYY-MM-DD venue-local date. */
const weekdayOf = (dateIso: string): number => new Date(`${dateIso}T00:00:00`).getDay();

const ruleMatches = (rule: RoundScheduleRule, dateIso: string): boolean => {
  if (rule.dateFrom !== null && dateIso < rule.dateFrom) return false;
  if (rule.dateTo !== null && dateIso > rule.dateTo) return false;
  // A dated rule without dateTo bounds only the start when a mask is present
  // ("Fridays from July 1"); without a mask it means that single date.
  if (rule.dateFrom !== null && rule.dateTo === null && rule.weekdayMask === null) {
    if (dateIso !== rule.dateFrom) return false;
  }
  if (rule.weekdayMask !== null && (rule.weekdayMask & (1 << weekdayOf(dateIso))) === 0) return false;
  return true;
};

/** Specificity class: lower wins. 0 single date, 1 bounded range, 2 recurring. */
const specificity = (rule: RoundScheduleRule): number => {
  if (rule.dateFrom !== null && (rule.dateTo === rule.dateFrom || (rule.dateTo === null && rule.weekdayMask === null))) {
    return 0;
  }
  if (rule.dateFrom !== null && rule.dateTo !== null) return 1;
  return 2;
};

/**
 * The winning rule for a date out of an already-loaded rule set — pure, so a
 * range query can resolve many dates from one rules read.
 */
export const resolveScheduleFromRules = (
  rules: RoundScheduleRule[],
  dateIso: string,
): ResolvedSchedule | null => {
  const matching = rules.filter((r) => ruleMatches(r, dateIso));
  if (matching.length === 0) return null;
  matching.sort(
    (a, b) => specificity(a) - specificity(b) || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  const winner = matching[0]!;
  return {
    windows: winner.windows,
    outside: winner.outside,
    // time columns come back as "HH:MM:SS"; normalize to "HH:MM".
    openFrom: winner.openFrom ? winner.openFrom.slice(0, 5) : null,
    openUntil: winner.openUntil ? winner.openUntil.slice(0, 5) : null,
    ruleId: winner.id,
  };
};

/**
 * The winning rule for a date, or null when no rule matches (default: all
 * rounds, mandatory). Loads all rules — the table is admin-curated and tiny.
 */
export const resolveScheduleForDate = async (
  db: AnyPgDatabase,
  dateIso: string,
): Promise<ResolvedSchedule | null> => {
  const rules = await db.select().from(roundScheduleRules);
  return resolveScheduleFromRules(rules, dateIso);
};

/** Does [start, end] (HH:MM or HH:MM:SS) fit ENTIRELY inside one window? */
export const roundFitsWindows = (start: string, end: string, windows: ScheduleWindow[]): boolean => {
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  return windows.some((w) => s >= w.start && e <= w.end);
};

export type SchedulableResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'filtered_by_schedule' };

/**
 * Booking-path guard (createHold, bookRoundWithPunch): is this instance's
 * round offered on its date under the winning schedule rule? No rule → yes.
 * Keeps direct API calls from booking a round the picker would never show.
 */
export const isInstanceSchedulable = async (
  db: AnyPgDatabase,
  roundInstanceId: string,
): Promise<SchedulableResult> => {
  const rows = await db
    .select({
      date: roundInstances.date,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
    })
    .from(roundInstances)
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(eq(roundInstances.id, roundInstanceId))
    .limit(1);
  const inst = rows[0];
  if (!inst) return { ok: false, reason: 'not_found' as const };
  const schedule = await resolveScheduleForDate(db, inst.date);
  if (!schedule) return { ok: true as const };
  if (!roundFitsWindows(inst.startTime, inst.endTime, schedule.windows)) {
    return { ok: false, reason: 'filtered_by_schedule' as const };
  }
  return { ok: true as const };
};
