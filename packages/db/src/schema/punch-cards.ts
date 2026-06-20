import {
  boolean,
  index,
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

export const punchCards = pgTable(
  'punch_cards',
  {
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
    // null = no expiry ("forever" cards, enabled when card_settings.validityDays = 0).
    // Non-null = created_at + validityDays.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    source: punchCardSourceEnum('source').notNull().default('pos'),
    // Receipt number printed by the AccuPOS register at the time of sale.
    // Required at the API layer for source='pos' (settings-driven); kept
    // nullable in the schema so historical rows from before the requirement
    // stay valid. UNIQUE at the DB level — multiple NULLs are allowed under
    // Postgres unique semantics, so historical NULL rows don't collide while
    // every recorded receipt number is enforced unique. Reusing the same
    // number twice is the lazy version of cashier-fraud (issuing a card
    // without ringing it up) and the constraint catches it for free.
    receiptNumber: varchar('receipt_number', { length: 64 }).unique(),
    // Cashier who issued the card, attributed by the per-sale PIN entered
    // at the till. Nullable for historical rows and for online/admin-issued
    // cards where there is no "selling" cashier.
    soldBy: uuid('sold_by').references(() => staff.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => staff.id),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Hot path for the WooCommerce reconciliation cron: SELECT ... WHERE
    // wc_order_id = ? per order, hourly. Without the index this becomes a
    // full table scan once `punch_cards` grows past a few thousand rows.
    index('punch_cards_wc_order_id_idx').on(table.wcOrderId),
    // Reports surface (next phase): "cards sold by cashier X" — admin
    // dashboard, performance metrics. Indexed up-front so the dashboard
    // doesn't full-scan when it ships.
    index('punch_cards_sold_by_idx').on(table.soldBy),
  ],
);

export type PunchCard = typeof punchCards.$inferSelect;
export type NewPunchCard = typeof punchCards.$inferInsert;
