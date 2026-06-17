import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { staff } from './staff';

export const punchCardSourceEnum = pgEnum('punch_card_source', ['pos', 'online', 'manual']);

export const punchCards = pgTable('punch_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id),
  wcOrderId: varchar('wc_order_id', { length: 64 }),
  serialNumber: varchar('serial_number', { length: 32 }).notNull().unique(), // M-YYYYMMDD-NNNN
  qrToken: varchar('qr_token', { length: 512 }).notNull().unique(), // HMAC-signed, server is source of truth
  keyId: varchar('key_id', { length: 32 }).notNull(), // which signing key signed this token (rotation)
  totalEntries: integer('total_entries').notNull().default(12),
  usedEntries: integer('used_entries').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // created_at + 365 days
  source: punchCardSourceEnum('source').notNull().default('pos'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: uuid('cancelled_by').references(() => staff.id),
  cancelReason: text('cancel_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PunchCard = typeof punchCards.$inferSelect;
export type NewPunchCard = typeof punchCards.$inferInsert;
