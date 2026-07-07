// Orchestrates the holiday-closure sync (plan 2026-07-07-jewish-holidays-
// closures): fetch a year from Hebcal, map it onto the DB layer's shapes, then
// upsert policies and regenerate this year's sync rules. Also builds the admin
// browse calendar as a read-only join of Hebcal's dates onto stored policies.
//
// Fail-open holds: the resolver never reads Hebcal live, only stored rules. If
// Hebcal is down, sales are unaffected; only this admin-triggered sync and the
// calendar view need Hebcal reachable.

import {
  listHolidayPolicies,
  regenerateHolidaySyncRules,
  SHABBAT_KEY,
  upsertHolidayPolicies,
  type HolidayCategory,
  type HolidayOccurrence,
  type HolidayPolicy,
  type ShabbatFriday,
} from '@memesh/db';
import { hebcalStableKey, type HebcalClient, type HebcalGeo } from './hebcal-client.js';

type Db = Parameters<typeof upsertHolidayPolicies>[0];

// Hebcal's candle-lighting offset (minutes before sunset). 40 is the common
// Israel value; the venue's "close N minutes before candle lighting" is a
// separate figure stored on the Shabbat policy row.
const CANDLE_OFFSET_MIN = 40;

const toCategory = (subcat: string): HolidayCategory =>
  subcat === 'major' || subcat === 'minor' || subcat === 'modern' || subcat === 'fast' ? subcat : 'minor';

export interface HolidaySyncDeps {
  db: Db;
  hebcal: HebcalClient;
  geo: HebcalGeo;
  log?: { info?: (obj: unknown, msg: string) => void };
}

export interface HolidaySyncResult {
  year: number;
  holidays: number;
  fridays: number;
  policiesInserted: number;
  policiesRefreshed: number;
  rulesDeleted: number;
  rulesCreated: number;
}

const fetchYear = async (
  deps: HolidaySyncDeps,
  year: number,
): Promise<{ occurrences: HolidayOccurrence[]; fridays: ShabbatFriday[] }> => {
  const holidays = await deps.hebcal.listHolidays(year);
  const occurrences: HolidayOccurrence[] = holidays.map((h) => ({
    holidayKey: hebcalStableKey(h.englishTitle),
    hebrewName: h.hebrewName,
    category: toCategory(h.subcat),
    yomtov: h.yomtov,
    date: h.date,
  }));
  const candles = await deps.hebcal.listCandleLighting(year, deps.geo, CANDLE_OFFSET_MIN);
  const fridays: ShabbatFriday[] = candles.map((c) => ({ date: c.date, candleTime: c.time }));
  return { occurrences, fridays };
};

/** Pull the year from Hebcal, upsert policies, regenerate this year's rules. */
export const runHolidaySync = async (
  deps: HolidaySyncDeps,
  year: number,
  now: Date = new Date(),
): Promise<HolidaySyncResult> => {
  const { occurrences, fridays } = await fetchYear(deps, year);
  const up = await upsertHolidayPolicies(deps.db, occurrences, now);
  const gen = await regenerateHolidaySyncRules(deps.db, { year, occurrences, fridays }, now);
  const result: HolidaySyncResult = {
    year,
    holidays: occurrences.length,
    fridays: fridays.length,
    policiesInserted: up.inserted,
    policiesRefreshed: up.refreshed,
    rulesDeleted: gen.deleted,
    rulesCreated: gen.created,
  };
  deps.log?.info?.(result, '[holidays sync]');
  return result;
};

/**
 * Re-materialize one year's rules from the current policies without touching
 * policy metadata. Called after Yanay changes a single decision so it reaches
 * the resolver immediately, without a full sync.
 */
export const regenerateHolidayRulesForYear = async (
  deps: HolidaySyncDeps,
  year: number,
  now: Date = new Date(),
): Promise<{ deleted: number; created: number }> => {
  const { occurrences, fridays } = await fetchYear(deps, year);
  return regenerateHolidaySyncRules(deps.db, { year, occurrences, fridays }, now);
};

export interface HolidayCalendarEntry {
  holidayKey: string;
  hebrewName: string;
  category: string;
  yomtov: boolean;
  policy: 'normal' | 'closed' | 'special_hours';
  confirmed: boolean;
  openTime: string | null;
  closeTime: string | null;
  shabbatCloseOffsetMinutes: number | null;
  note: string | null;
  /** Occurrence date(s) in the target year (one per holiday; every Friday for Shabbat). */
  dates: string[];
}

const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

const entryFrom = (
  holidayKey: string,
  hebrewName: string,
  category: string,
  yomtov: boolean,
  dates: string[],
  policy: HolidayPolicy | undefined,
): HolidayCalendarEntry => ({
  holidayKey,
  hebrewName: policy?.hebrewName ?? hebrewName,
  category,
  yomtov,
  policy: policy?.policy ?? 'normal',
  confirmed: policy?.confirmedAt != null,
  openTime: hhmm(policy?.openTime ?? null),
  closeTime: hhmm(policy?.closeTime ?? null),
  shabbatCloseOffsetMinutes: policy?.shabbatCloseOffsetMinutes ?? null,
  note: policy?.note ?? null,
  dates,
});

/**
 * The admin browse calendar for a year: every holiday and the weekly Shabbat,
 * each with its real date(s) and current decision. Read-only join of Hebcal's
 * dates onto stored policies — a holiday with no policy yet shows as normal +
 * unconfirmed so Yanay can decide it.
 */
export const buildHolidayCalendar = async (
  deps: HolidaySyncDeps,
  year: number,
): Promise<{ year: number; entries: HolidayCalendarEntry[] }> => {
  const { occurrences, fridays } = await fetchYear(deps, year);
  const policies = await listHolidayPolicies(deps.db);
  const policyByKey = new Map(policies.map((p) => [p.holidayKey, p]));

  // One entry per holiday key (first occurrence carries its metadata; dates
  // collect every occurrence — normally one per key per year).
  const byKey = new Map<string, HolidayCalendarEntry>();
  for (const occ of occurrences) {
    const existing = byKey.get(occ.holidayKey);
    if (existing) {
      existing.dates.push(occ.date);
      continue;
    }
    byKey.set(
      occ.holidayKey,
      entryFrom(occ.holidayKey, occ.hebrewName, occ.category, occ.yomtov, [occ.date], policyByKey.get(occ.holidayKey)),
    );
  }

  const entries = [...byKey.values()];
  // The weekly Shabbat entry, carrying every Friday date in the year.
  entries.push(
    entryFrom('shabbat', 'שבת', 'shabbat', false, fridays.map((f) => f.date), policyByKey.get(SHABBAT_KEY)),
  );

  entries.sort((a, b) => (a.dates[0] ?? '').localeCompare(b.dates[0] ?? ''));
  return { year, entries };
};
