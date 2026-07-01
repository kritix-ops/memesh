import { pgTable, smallint, timestamp } from 'drizzle-orm/pg-core';

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
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RoundSettingsRow = typeof roundSettings.$inferSelect;
export type NewRoundSettings = typeof roundSettings.$inferInsert;
