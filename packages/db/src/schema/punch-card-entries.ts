import { integer, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { punchCards } from './punch-cards';
import { staff } from './staff';

export const punchMethodEnum = pgEnum('punch_method', ['qr_scan', 'serial', 'phone', 'manual']);

export const punchCardEntries = pgTable('punch_card_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  punchCardId: uuid('punch_card_id')
    .notNull()
    .references(() => punchCards.id),
  punchedBy: uuid('punched_by').references(() => staff.id), // null for online/system punches
  method: punchMethodEnum('method').notNull(),
  companionCount: integer('companion_count').notNull().default(1), // metadata only; one punch = one entry
  idempotencyKey: varchar('idempotency_key', { length: 64 }).unique(), // safe retry / double-tap guard
  notes: text('notes'),
  punchedAt: timestamp('punched_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PunchCardEntry = typeof punchCardEntries.$inferSelect;
export type NewPunchCardEntry = typeof punchCardEntries.$inferInsert;
