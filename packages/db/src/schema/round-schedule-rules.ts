import { sql } from 'drizzle-orm';
import { date, jsonb, pgEnum, pgTable, smallint, time, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Scheduling rules for when the rounds system applies (Yoav 2026-07-02,
// replaces the short-lived round_off_dates). A rule scopes a set of dates —
// a single date, a bounded range, recurring weekdays, or a combination — and
// says during which time windows rounds run there. Rounds must fit ENTIRELY
// inside a window to be offered. `outside` decides what the rest of the day
// is: 'free_play' (tickets sell without a round) or 'closed' (rounds are the
// only way in, so outside the windows nothing is sold).
//
// windows = [] turns rounds off for the whole matched day (free_play → open
// day without rounds; closed → the venue sells nothing online that day).
// Specificity when several rules match a date: single-date > bounded range >
// recurring; ties resolved by most recently updated. Resolution logic lives
// in rounds-schedule.ts.

export const roundScheduleOutsideEnum = pgEnum('round_schedule_outside', ['free_play', 'closed']);

// Provenance. 'manual' rows are authored by an admin in the schedule UI and are
// NEVER touched by the holiday sync. 'holiday_sync' rows are regenerated each
// run from confirmed holiday_policies (plan 2026-07-07-jewish-holidays-closures).
export const roundScheduleSourceEnum = pgEnum('round_schedule_source', ['manual', 'holiday_sync']);

export interface ScheduleWindow {
  /** "HH:MM" */
  start: string;
  /** "HH:MM", strictly after start. */
  end: string;
}

export const roundScheduleRules = pgTable('round_schedule_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Scope: any combination; at least one of date_from / weekday_mask must be
  // set (enforced in the helper). date_to requires date_from.
  dateFrom: date('date_from'),
  dateTo: date('date_to'),
  // Bit 0 = Sunday … bit 6 = Saturday; null = every weekday in the range.
  weekdayMask: smallint('weekday_mask'),
  // Time windows in which rounds run. Empty array = no rounds that day.
  windows: jsonb('windows').$type<ScheduleWindow[]>().notNull().default(sql`'[]'::jsonb`),
  outside: roundScheduleOutsideEnum('outside').notNull().default('free_play'),
  // On a 'free_play' day, bound the venue's open hours in venue-local "HH:MM"
  // (special hours / Friday early-close). Null = open all day. Ignored when
  // outside = 'closed'. The resolver keeps the day sellable and surfaces these.
  openFrom: time('open_from'),
  openUntil: time('open_until'),
  // Provenance + idempotency for the holiday sync. source_key is
  // `${holidayKey}:${year}` for holidays and the Friday ISO date for Shabbat;
  // null on manual rows. Lets the sync rebuild its own rows without ever
  // touching a manual one.
  source: roundScheduleSourceEnum('source').notNull().default('manual'),
  sourceKey: varchar('source_key', { length: 96 }),
  // Admin-facing label ("חנוכה", "שיפוצים") so the list stays readable.
  note: varchar('note', { length: 120 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RoundScheduleRule = typeof roundScheduleRules.$inferSelect;
export type NewRoundScheduleRule = typeof roundScheduleRules.$inferInsert;
