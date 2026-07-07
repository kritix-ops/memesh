import { boolean, pgEnum, pgTable, smallint, time, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Yanay's per-holiday closure decision (plan 2026-07-07-jewish-holidays-closures).
// One row per Jewish holiday plus a single 'shabbat' row for the weekly Friday
// early-close. Keyed by a STABLE cross-year identity (Hebcal's English title
// with the trailing Hebrew year stripped) so a decision set once keeps applying
// as the Gregorian date shifts year to year. The concrete dated closures live
// in round_schedule_rules (source = 'holiday_sync'); this table is the durable
// policy the yearly sync regenerates them from.
//
// Safety: policy defaults to 'normal' and confirmed_at stays null until Yanay
// reviews the holiday, so a newly-discovered holiday NEVER closes the venue on
// its own. Only a confirmed 'closed'/'special_hours' policy generates a rule.

export const holidayCategoryEnum = pgEnum('holiday_category', [
  'major',
  'minor',
  'modern',
  'fast',
  'shabbat',
]);

export const holidayPolicyStateEnum = pgEnum('holiday_policy_state', [
  'normal',
  'closed',
  'special_hours',
]);

export const holidayPolicies = pgTable('holiday_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stable key from hebcalStableKey(englishTitle); 'shabbat' for the weekly row.
  holidayKey: varchar('holiday_key', { length: 80 }).notNull().unique(),
  // Hebrew display name (no nikud), refreshed on every sync.
  hebrewName: varchar('hebrew_name', { length: 120 }).notNull(),
  category: holidayCategoryEnum('category').notNull(),
  // True on work-forbidden yom tov days (Hebcal `yomtov`). Purely informational —
  // it drives UI grouping and a sensible suggested default, not the resolver.
  yomtov: boolean('yomtov').notNull().default(false),
  // Yanay's decision. 'normal' (the default) generates no rule at all.
  policy: holidayPolicyStateEnum('policy').notNull().default('normal'),
  // Special-hours open/close in venue-local "HH:MM"; null unless special_hours.
  openTime: time('open_time'),
  closeTime: time('close_time'),
  // Shabbat row only: minutes before candle-lighting the venue closes.
  shabbatCloseOffsetMinutes: smallint('shabbat_close_offset_minutes'),
  // Null until Yanay confirms; drives the "needs a decision" flag and gates rule
  // generation so an unreviewed holiday can never close the venue.
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  note: varchar('note', { length: 120 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type HolidayPolicy = typeof holidayPolicies.$inferSelect;
export type NewHolidayPolicy = typeof holidayPolicies.$inferInsert;
