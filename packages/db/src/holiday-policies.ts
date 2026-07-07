// Holiday-closure sync core (plan 2026-07-07-jewish-holidays-closures). Pure DB
// logic — the Hebcal fetch lives in apps/api and hands us already-dated
// occurrences, so this layer is fully testable under PGlite.
//
// Two writes:
//   upsertHolidayPolicies      — one durable policy row per holiday identity
//                                (metadata refreshed; Yanay's decision never
//                                touched) plus the single weekly 'shabbat' row.
//   regenerateHolidaySyncRules — idempotently rebuild THIS year's
//                                source='holiday_sync' rows in
//                                round_schedule_rules from CONFIRMED, non-normal
//                                policies. Manual rows are never touched.
//
// Safety (fail-open): a holiday generates a closure only when its policy is both
// confirmed and non-normal. Newly-discovered holidays land as 'normal' +
// unconfirmed and produce nothing. An empty occurrence list generates no rows.

import { and, asc, eq, gte, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { holidayPolicies, type HolidayPolicy, roundScheduleRules } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export const SHABBAT_KEY = 'shabbat';
export const DEFAULT_SHABBAT_OFFSET_MIN = 40;

export type HolidayCategory = 'major' | 'minor' | 'modern' | 'fast';

/** A holiday on a concrete date in the sync's target year. */
export interface HolidayOccurrence {
  holidayKey: string;
  hebrewName: string;
  category: HolidayCategory;
  yomtov: boolean;
  /** YYYY-MM-DD. */
  date: string;
}

/** One Friday with its candle-lighting time (venue-local "HH:MM"). */
export interface ShabbatFriday {
  date: string;
  candleTime: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** All policy rows, holiday key order — the admin calendar joins dates onto these. */
export const listHolidayPolicies = async (db: AnyPgDatabase): Promise<HolidayPolicy[]> =>
  db.select().from(holidayPolicies).orderBy(asc(holidayPolicies.holidayKey));

export interface HolidayPolicyPatch {
  policy?: 'normal' | 'closed' | 'special_hours';
  openTime?: string | null;
  closeTime?: string | null;
  shabbatCloseOffsetMinutes?: number | null;
  note?: string | null;
  /** Toggles confirmed_at (now / null). Confirming gates rule generation. */
  confirmed?: boolean;
}

export type SetHolidayPolicyResult =
  | { ok: true; policy: HolidayPolicy }
  | { ok: false; error: 'not_found' | 'time_invalid' | 'special_hours_needs_times' | 'offset_invalid' };

/**
 * Update one holiday's decision (Yanay's action from the browse view). Validates
 * that special-hours holidays carry an open+close time (Shabbat is exempt — its
 * close is computed per-Friday from candle-lighting). Caller regenerates rules
 * afterward so the change reaches the resolver.
 */
export const setHolidayPolicy = async (
  db: AnyPgDatabase,
  holidayKey: string,
  patch: HolidayPolicyPatch,
  now: Date = new Date(),
): Promise<SetHolidayPolicyResult> => {
  if (patch.openTime != null && !HHMM_RE.test(patch.openTime)) return { ok: false, error: 'time_invalid' };
  if (patch.closeTime != null && !HHMM_RE.test(patch.closeTime)) return { ok: false, error: 'time_invalid' };
  if (
    patch.shabbatCloseOffsetMinutes != null &&
    (!Number.isInteger(patch.shabbatCloseOffsetMinutes) ||
      patch.shabbatCloseOffsetMinutes < 0 ||
      patch.shabbatCloseOffsetMinutes > 300)
  ) {
    return { ok: false, error: 'offset_invalid' };
  }

  const existing = (
    await db.select().from(holidayPolicies).where(eq(holidayPolicies.holidayKey, holidayKey)).limit(1)
  )[0];
  if (!existing) return { ok: false, error: 'not_found' };

  const effPolicy = patch.policy ?? existing.policy;
  const effOpen = patch.openTime !== undefined ? patch.openTime : existing.openTime;
  const effClose = patch.closeTime !== undefined ? patch.closeTime : existing.closeTime;
  // A special-hours holiday needs both times; Shabbat's close comes from candle
  // lighting so it is exempt.
  if (effPolicy === 'special_hours' && holidayKey !== SHABBAT_KEY && (!effOpen || !effClose)) {
    return { ok: false, error: 'special_hours_needs_times' };
  }
  if (effPolicy === 'special_hours' && effOpen && effClose && effClose.slice(0, 5) <= effOpen.slice(0, 5)) {
    return { ok: false, error: 'time_invalid' };
  }

  const set: Record<string, unknown> = { updatedAt: now };
  if (patch.policy !== undefined) set.policy = patch.policy;
  if (patch.openTime !== undefined) set.openTime = patch.openTime;
  if (patch.closeTime !== undefined) set.closeTime = patch.closeTime;
  if (patch.shabbatCloseOffsetMinutes !== undefined) set.shabbatCloseOffsetMinutes = patch.shabbatCloseOffsetMinutes;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.confirmed !== undefined) set.confirmedAt = patch.confirmed ? now : null;

  const updated = await db
    .update(holidayPolicies)
    .set(set)
    .where(eq(holidayPolicies.holidayKey, holidayKey))
    .returning();
  return { ok: true, policy: updated[0]! };
};

/** "HH:MM" minus N minutes, clamped to 00:00. Pure. */
export const subtractMinutes = (hhmm: string, minutes: number): string => {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.max(0, (h ?? 0) * 60 + (m ?? 0) - minutes);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/**
 * Ensure a durable policy row exists for every holiday identity in
 * `occurrences` (deduped by key) plus the weekly Shabbat row. New rows default
 * to 'normal' + unconfirmed so they can never close the venue on their own.
 * Existing rows have only their display metadata refreshed — policy,
 * confirmed_at and the special-hours times are Yanay's and are left alone.
 */
export const upsertHolidayPolicies = async (
  db: AnyPgDatabase,
  occurrences: HolidayOccurrence[],
  now: Date = new Date(),
): Promise<{ inserted: number; refreshed: number }> => {
  const byKey = new Map<string, HolidayOccurrence>();
  for (const o of occurrences) if (!byKey.has(o.holidayKey)) byKey.set(o.holidayKey, o);

  const existing = await db.select({ k: holidayPolicies.holidayKey }).from(holidayPolicies);
  const existingKeys = new Set(existing.map((r) => r.k));

  if (byKey.size > 0) {
    await db
      .insert(holidayPolicies)
      .values(
        [...byKey.values()].map((o) => ({
          holidayKey: o.holidayKey,
          hebrewName: o.hebrewName,
          category: o.category,
          yomtov: o.yomtov,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: holidayPolicies.holidayKey,
        set: {
          hebrewName: sql`excluded.hebrew_name`,
          category: sql`excluded.category`,
          yomtov: sql`excluded.yomtov`,
          updatedAt: now,
        },
      });
  }

  // The single weekly Shabbat row — created once, never overwritten.
  await db
    .insert(holidayPolicies)
    .values({
      holidayKey: SHABBAT_KEY,
      hebrewName: 'שבת',
      category: 'shabbat',
      shabbatCloseOffsetMinutes: DEFAULT_SHABBAT_OFFSET_MIN,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: holidayPolicies.holidayKey });

  let inserted = 0;
  let refreshed = 0;
  for (const k of byKey.keys()) if (existingKeys.has(k)) refreshed += 1;
    else inserted += 1;
  return { inserted, refreshed };
};

interface NewSyncRule {
  dateFrom: string;
  dateTo: string;
  weekdayMask: null;
  windows: [];
  outside: 'free_play' | 'closed';
  openFrom: string | null;
  openUntil: string | null;
  source: 'holiday_sync';
  sourceKey: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const holidayRule = (
  policy: HolidayPolicy,
  date: string,
  sourceKey: string,
  note: string,
  now: Date,
): NewSyncRule => {
  const base = {
    dateFrom: date,
    dateTo: date,
    weekdayMask: null as null,
    windows: [] as [],
    source: 'holiday_sync' as const,
    sourceKey,
    note: note.slice(0, 120),
    createdAt: now,
    updatedAt: now,
  };
  if (policy.policy === 'closed') {
    return { ...base, outside: 'closed', openFrom: null, openUntil: null };
  }
  // special_hours: still sellable, bounded open hours.
  return {
    ...base,
    outside: 'free_play',
    openFrom: policy.openTime ?? null,
    openUntil: policy.closeTime ?? null,
  };
};

export interface RegenerateInput {
  year: number;
  occurrences: HolidayOccurrence[];
  fridays: ShabbatFriday[];
}

/**
 * Rebuild this year's holiday_sync rows. Deletes the year's sync-owned rows
 * (manual rows untouched) then regenerates from confirmed, non-normal policies.
 * A confirmed holiday that falls on a Friday wins over the generic Shabbat
 * early-close, so we never emit two single-date rules for one date.
 */
export const regenerateHolidaySyncRules = async (
  db: AnyPgDatabase,
  input: RegenerateInput,
  now: Date = new Date(),
): Promise<{ deleted: number; created: number }> => {
  const { year, occurrences, fridays } = input;
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const deleted = await db
    .delete(roundScheduleRules)
    .where(
      and(
        eq(roundScheduleRules.source, 'holiday_sync'),
        gte(roundScheduleRules.dateFrom, yearStart),
        lte(roundScheduleRules.dateFrom, yearEnd),
      ),
    )
    .returning({ id: roundScheduleRules.id });

  const policies = await db
    .select()
    .from(holidayPolicies)
    .where(and(isNotNull(holidayPolicies.confirmedAt), ne(holidayPolicies.policy, 'normal')));
  const policyByKey = new Map(policies.map((p) => [p.holidayKey, p]));

  const rows: NewSyncRule[] = [];
  const datesTaken = new Set<string>();
  for (const occ of occurrences) {
    const policy = policyByKey.get(occ.holidayKey);
    if (!policy) continue;
    rows.push(holidayRule(policy, occ.date, `${occ.holidayKey}:${year}`, occ.hebrewName, now));
    datesTaken.add(occ.date);
  }

  const shabbat = policyByKey.get(SHABBAT_KEY);
  if (shabbat) {
    const offset = shabbat.shabbatCloseOffsetMinutes ?? DEFAULT_SHABBAT_OFFSET_MIN;
    for (const fri of fridays) {
      if (datesTaken.has(fri.date)) continue; // a chag on this Friday already ruled it
      if (shabbat.policy === 'closed') {
        rows.push({
          dateFrom: fri.date,
          dateTo: fri.date,
          weekdayMask: null,
          windows: [],
          outside: 'closed',
          openFrom: null,
          openUntil: null,
          source: 'holiday_sync',
          sourceKey: `${SHABBAT_KEY}:${fri.date}`,
          note: 'שבת',
          createdAt: now,
          updatedAt: now,
        });
      } else {
        rows.push({
          dateFrom: fri.date,
          dateTo: fri.date,
          weekdayMask: null,
          windows: [],
          outside: 'free_play',
          openFrom: shabbat.openTime ?? null,
          openUntil: subtractMinutes(fri.candleTime, offset),
          source: 'holiday_sync',
          sourceKey: `${SHABBAT_KEY}:${fri.date}`,
          note: 'שבת',
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  let created = 0;
  if (rows.length > 0) {
    const ins = await db.insert(roundScheduleRules).values(rows).returning({ id: roundScheduleRules.id });
    created = ins.length;
  }
  return { deleted: deleted.length, created };
};
