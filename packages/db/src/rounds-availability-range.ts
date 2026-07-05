// Multi-day availability for the customer day-strip picker (plan
// 2026-07-05-rounds-day-strip). One row per calendar day, composed exactly like
// the single-date /rounds/availability route: master switch + any-active-rounds
// once, then per date the winning schedule rule filters which rounds are offered
// (fit ENTIRELY inside a window) and decides whether picking one is mandatory.
// Pure read — the strip only renders what the picker would show anyway.

import type { PgDatabase } from 'drizzle-orm/pg-core';
import { addIsoDays } from './round-time';
import { getRoundSettings } from './round-settings';
import { anyActiveRounds, roundAvailabilityForDate, type RoundAvailabilityRow } from './rounds';
import { resolveScheduleForDate, roundFitsWindows } from './rounds-schedule';

type AnyPgDatabase = PgDatabase<any, any, any>;

export interface DayAvailability {
  /** YYYY-MM-DD */
  date: string;
  /** false = free play on this date — rounds (if any) are optional. */
  roundsRequired: boolean;
  rounds: RoundAvailabilityRow[];
}

/**
 * Availability for `days` consecutive dates starting at `fromIso`. With the
 * rounds system off (master switch or no active rounds) every day comes back
 * as free play with no rounds — same contract as the single-date route.
 */
export const roundAvailabilityRange = async (
  db: AnyPgDatabase,
  fromIso: string,
  days: number,
  now: Date = new Date(),
): Promise<DayAvailability[]> => {
  const settings = await getRoundSettings(db);
  const systemOn = settings.roundsEnabled && (await anyActiveRounds(db));

  const result: DayAvailability[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addIsoDays(fromIso, i);
    if (!systemOn) {
      result.push({ date, roundsRequired: false, rounds: [] });
      continue;
    }
    const schedule = await resolveScheduleForDate(db, date);
    let rows = await roundAvailabilityForDate(db, date, now);
    let roundsRequired = true;
    if (schedule) {
      rows = rows.filter((r) => roundFitsWindows(r.startTime, r.endTime, schedule.windows));
      roundsRequired = schedule.outside === 'closed';
    }
    result.push({ date, roundsRequired, rounds: rows });
  }
  return result;
};
