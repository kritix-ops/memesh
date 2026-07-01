import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, smallint, time, timestamp } from 'drizzle-orm/pg-core';

// Singleton config for the rounds *operational* params (super-brief §15) — the
// knobs the purchase / cancel / waitlist flow reads at runtime. Separate from
// dashboard_settings (display) and card_settings (product). Exactly one row
// (id = 1, CHECK-enforced in the migration).
//
// Introduced lean with only what the spine reads; more §15 params (active
// hours, reminder offsets, companion rules, etc.) get added as their features
// land. CHECK constraints live in the migration; range validation lives with
// the helpers in round-settings.ts.
export const roundSettings = pgTable('round_settings', {
  id: smallint('id').primaryKey().notNull().default(1),
  // Minutes a seat is held before payment (super-brief §3). Default 15.
  holdTtlMinutes: smallint('hold_ttl_minutes').notNull().default(15),
  // Hours before a round's start that a paid booking may still be cancelled
  // for a refund (super-brief §6.2). After this, swap only. Default 24.
  cancellationWindowHours: smallint('cancellation_window_hours').notNull().default(24),
  // Minutes a waitlisted customer has to claim a freed seat (super-brief §8).
  // Default 60.
  claimWindowMinutes: smallint('claim_window_minutes').notNull().default(60),
  // Venue-local hours (0-23) within which a waitlist offer may be sent
  // (super-brief §8.2 "quiet hours"). A seat that frees outside this window
  // waits for the next active-hours sweep. Default 08:00-22:00.
  activeHoursStart: smallint('active_hours_start').notNull().default(8),
  activeHoursEnd: smallint('active_hours_end').notNull().default(22),
  // Minutes before a round's end_time to send a stay-duration reminder to its
  // confirmed bookings (super-brief §9). Default [30, 10].
  reminderOffsets: integer('reminder_offsets').array().notNull().default(sql`'{30,10}'::integer[]`),
  // The venue's daily closing time; used with skipLastRoundReminder to suppress
  // a pointless "almost done" ping on the final round of the day.
  closingTime: time('closing_time').notNull().default('19:00:00'),
  skipLastRoundReminder: boolean('skip_last_round_reminder').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RoundSettingsRow = typeof roundSettings.$inferSelect;
export type NewRoundSettings = typeof roundSettings.$inferInsert;
