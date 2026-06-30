import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { rounds } from './rounds';

// Materialization of a `round` template for a specific calendar date.
// Carries the EFFECTIVE capacity for that date — copied from the parent
// round's default_capacity at creation but admin can override per date
// (e.g., reduce for a private event, raise for a special day).
//
// All bookings + waitlist entries hang off round_instance, not round, so
// historical bookings remain valid even after the parent template is
// reshaped.
export const roundInstances = pgTable(
  'round_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => rounds.id),
    date: date('date').notNull(),
    capacity: integer('capacity').notNull(),
    // Manual closure flag — separate from rounds.isActive. isActive turns
    // off the recurring template; isClosed kills a single instance (private
    // event, holiday). Set by admin from the per-date override panel.
    isClosed: boolean('is_closed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Exactly one materialization per (round, date) — prevents duplicate
    // instances if two admin actions race. Matches the SQL UNIQUE
    // constraint in 0015_rounds.sql.
    uniqueIndex('round_instances_round_date_unique').on(table.roundId, table.date),
    // Hot path: "today's rounds" and "round picker for date X" both query
    // by date. Without the index, dashboard page-loads scan the table.
    index('round_instances_date_idx').on(table.date),
  ],
);

export type RoundInstance = typeof roundInstances.$inferSelect;
export type NewRoundInstance = typeof roundInstances.$inferInsert;
