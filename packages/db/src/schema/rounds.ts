import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  smallint,
  time,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// Shared ticket-type enum — used by bookings and waitlist_entries.
// Lives in rounds.ts because the round-system conceptually owns the
// definition; importing from here keeps a single source of truth.
export const ticketTypeEnum = pgEnum('ticket_type', [
  'child_under_walking',
  'child_over_walking',
]);

// Recurring template for a round. Each row defines WHEN a round happens
// (start/end time, which weekdays it runs) and its DEFAULT capacity. A
// `round_instance` is the materialization of this template on a specific
// date — that's where overrides and bookings hang off.
export const rounds = pgTable('rounds', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Internal label admin uses to identify the round in lists/filters.
  // Examples: 'morning', 'afternoon', 'evening'. Free-form, not enum'd
  // because Yanay may want bespoke labels per location later.
  label: varchar('label', { length: 64 }).notNull(),
  // Customer-facing name shown in the round picker. Hebrew, e.g.
  // "סבב אחר הצהריים". Editable so we can polish copy without code.
  displayName: varchar('display_name', { length: 128 }).notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  // Bitmask of weekdays the round runs. Bit 0 = Sunday … bit 6 = Saturday.
  // 127 (= 0b1111111) = all 7 days, the default. Admin flips bits to
  // disable a round on specific weekdays (e.g., closed Saturdays).
  daysActive: smallint('days_active').notNull().default(127),
  defaultCapacity: integer('default_capacity').notNull(),
  // Master switch for the round template. Toggling off doesn't delete
  // historical round_instances or bookings; it just stops new instances
  // from being created (or being shown in the picker, depending on
  // upstream behaviour wired in step 2b).
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Round = typeof rounds.$inferSelect;
export type NewRound = typeof rounds.$inferInsert;
