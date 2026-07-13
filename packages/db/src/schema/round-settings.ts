import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, smallint, text, time, timestamp } from 'drizzle-orm/pg-core';

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
  // Master switch for the whole rounds system (Yoav 2026-07-02, dev-phase
  // control). Off → the WP picker is never mandatory, availability reports
  // roundsRequired=false, and entry tickets sell as plain products. Round
  // templates/instances stay intact for when it's flipped back on.
  roundsEnabled: boolean('rounds_enabled').notNull().default(true),
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
  // Staff/admin walk-in adds may exceed a full round's capacity (Yanay
  // 2026-07-07). Off → a full round refuses a walk-in. Default on.
  allowOverCapacityWalkIn: boolean('allow_over_capacity_walk_in').notNull().default(true),
  // Warn the cashier at the door when the scanned card's customer has an
  // upcoming reserved round whose entry is already committed (Yanay
  // 2026-07-07). Default on.
  warnUpcomingReservationAtDoor: boolean('warn_upcoming_reservation_at_door').notNull().default(true),
  // How many days ahead a customer may register (Yanay 2026-07-13: "let them
  // register a month ahead, not more"). The calendar caps at today + this many
  // days, and the booking-path guard refuses a round dated beyond it. Default
  // 30. Independent of INSTANCE_HORIZON_DAYS, which is how far instances mint.
  bookingHorizonDays: smallint('booking_horizon_days').notNull().default(30),
  // Minutes after a round's end time during which staff may still mark arrivals
  // (Yanay 2026-07-13 wanted marking locked once a round is over; this grace
  // keeps the floor from being cut off mid-tap for a straggler). 0 = a hard
  // lock exactly at end time. Default 30.
  markingGraceMinutes: smallint('marking_grace_minutes').notNull().default(30),
  // Interim cancellation mode (Yanay 2026-07-13, "בינתיים"): while the payment
  // provider has no refund API, a customer cancel frees the seat WITHOUT the
  // automatic WooCommerce refund and instead emails the staff to refund by hand
  // + emails the customer a confirmation. Default true (auto-refund is currently
  // broken); flip to false once the new provider's auto-refund works.
  manualRefundOnCancel: boolean('manual_refund_on_cancel').notNull().default(true),
  // Where the "please refund manually" alert goes when manualRefundOnCancel is
  // on. Empty → no staff alert is sent (logged). Set to the venue's ops inbox.
  cancellationAlertEmail: text('cancellation_alert_email').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RoundSettingsRow = typeof roundSettings.$inferSelect;
export type NewRoundSettings = typeof roundSettings.$inferInsert;
