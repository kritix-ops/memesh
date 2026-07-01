import { date, pgTable, timestamp } from 'drizzle-orm/pg-core';

// Dates on which the rounds system is switched off (Yoav 2026-07-02): on an
// off date choosing a round is never mandatory — entry tickets sell as plain
// products and availability reports roundsRequired=false with no bookable
// rounds. Distinct from round_instances.is_closed, which means "this round is
// closed that day, no entry sold against it"; an off date means "free play,
// no round needed".
export const roundOffDates = pgTable('round_off_dates', {
  /** YYYY-MM-DD, the venue-local calendar date. */
  date: date('date').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RoundOffDate = typeof roundOffDates.$inferSelect;
