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
  /** Number of entries this scan consumed from the card. Drives the
   * decrement of punch_cards.used_entries; bounded by remaining at scan time. */
  entriesConsumed: integer('entries_consumed').notNull().default(1),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).unique(), // safe retry / double-tap guard
  notes: text('notes'),
  punchedAt: timestamp('punched_at', { withTimezone: true }).notNull().defaultNow(),
  // Refund metadata. When refundedAt is non-null the entry no longer counts
  // toward usedEntries on the card. refundedBy is the cashier who initiated
  // the refund; approvedBy is the admin whose password authorized it
  // (same person when the admin self-served).
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  refundedBy: uuid('refunded_by').references(() => staff.id),
  approvedBy: uuid('approved_by').references(() => staff.id),
  refundReason: text('refund_reason'),
});

export type PunchCardEntry = typeof punchCardEntries.$inferSelect;
export type NewPunchCardEntry = typeof punchCardEntries.$inferInsert;
