// Multi-day availability for the day-strip pickers (plan
// 2026-07-05-rounds-day-strip). One row per calendar day, composed exactly like
// the single-date /rounds/availability route: master switch + any-active-rounds
// once, then per date the winning schedule rule filters which rounds are offered
// (fit ENTIRELY inside a window) and decides whether picking one is mandatory.
// Pure read — the strip only renders what the picker would show anyway.
//
// Batched on purpose: the first version looped the per-date helpers and issued
// ~5 queries per day (150 for a month), which made the picker visibly slow to
// open (Yoav 2026-07-05). This shape is 5 queries total regardless of range —
// rules once, instances once, booking counts grouped once.

import { and, count, eq, gte, lte, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { addIsoDays } from './round-time';
import { getRoundSettings } from './round-settings';
import { anyActiveRounds, type RoundAvailabilityRow } from './rounds';
import { resolveScheduleFromRules, roundFitsWindows } from './rounds-schedule';
import { bookings, roundInstances, roundScheduleRules, rounds } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export interface DayAvailability {
  /** YYYY-MM-DD */
  date: string;
  /** false = free play on this date — rounds (if any) are optional. */
  roundsRequired: boolean;
  /**
   * An admin rule explicitly shut this day: outside behavior 'closed' and no
   * round survives the rule's windows — nothing bookable, no free play. Days
   * that merely have no rounds (no rule, or past the horizon) are NOT closed.
   */
  closed: boolean;
  /**
   * Free-play open/close bounds ("HH:MM") for a special-hours or Friday
   * early-close day — the day stays sellable, these are for display. Null when
   * the day is open all day (or closed / rounds-required).
   */
  openFrom: string | null;
  openUntil: string | null;
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
  const dates = Array.from({ length: days }, (_, i) => addIsoDays(fromIso, i));
  if (!systemOn) {
    return dates.map((date) => ({
      date,
      roundsRequired: false,
      closed: false,
      openFrom: null,
      openUntil: null,
      rounds: [],
    }));
  }
  const toIso = dates[dates.length - 1]!;

  // Everything the per-date composition needs, read once for the whole range.
  const rules = await db.select().from(roundScheduleRules);
  const instances = await db
    .select({
      id: roundInstances.id,
      roundId: roundInstances.roundId,
      date: roundInstances.date,
      capacity: roundInstances.capacity,
      isClosed: roundInstances.isClosed,
      label: rounds.displayName,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
    })
    .from(roundInstances)
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(
      and(gte(roundInstances.date, fromIso), lte(roundInstances.date, toIso), eq(rounds.isActive, true)),
    );

  // Seat counts follow super-brief §1.3, same predicate as the single-date
  // read: confirmed + used + unexpired holds; companions never count.
  const takenRows = await db
    .select({ roundInstanceId: bookings.roundInstanceId, n: count() })
    .from(bookings)
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .where(
      and(
        gte(roundInstances.date, fromIso),
        lte(roundInstances.date, toIso),
        sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
      ),
    )
    .groupBy(bookings.roundInstanceId);
  const takenByInstance = new Map(takenRows.map((r) => [r.roundInstanceId, Number(r.n)]));

  const rowsByDate = new Map<string, RoundAvailabilityRow[]>();
  for (const inst of instances) {
    const taken = takenByInstance.get(inst.id) ?? 0;
    const row: RoundAvailabilityRow = {
      roundInstanceId: inst.id,
      roundId: inst.roundId,
      label: inst.label,
      startTime: inst.startTime.slice(0, 5),
      endTime: inst.endTime.slice(0, 5),
      capacity: inst.capacity,
      taken,
      available: Math.max(0, inst.capacity - taken),
      isClosed: inst.isClosed,
    };
    const list = rowsByDate.get(inst.date);
    if (list) list.push(row);
    else rowsByDate.set(inst.date, [row]);
  }

  return dates.map((date) => {
    const schedule = resolveScheduleFromRules(rules, date);
    let dayRows = rowsByDate.get(date) ?? [];
    let roundsRequired = true;
    if (schedule) {
      dayRows = dayRows.filter((r) => roundFitsWindows(r.startTime, r.endTime, schedule.windows));
      roundsRequired = schedule.outside === 'closed';
    }
    dayRows.sort((a, b) => a.startTime.localeCompare(b.startTime));
    const closed = schedule !== null && schedule.outside === 'closed' && dayRows.length === 0;
    // Open/close hours only apply to a free-play (still sellable) day.
    const openFrom = schedule && schedule.outside === 'free_play' ? schedule.openFrom : null;
    const openUntil = schedule && schedule.outside === 'free_play' ? schedule.openUntil : null;
    return { date, roundsRequired, closed, openFrom, openUntil, rounds: dayRows };
  });
};
