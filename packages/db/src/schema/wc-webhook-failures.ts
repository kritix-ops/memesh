import { jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { staff } from './staff';

// Manual-review queue for WooCommerce webhooks we received but could not
// process safely (phone missing or invalid, unknown SKU, validation failure,
// etc.). Never drop silently — every failure ends up here so an admin can act
// on it (manually create the card, refund the order, contact the customer).
//
// `reason` is an open varchar rather than a pgEnum because the reason set is
// expected to grow as we learn the real shapes of failure. Migrations to add
// a new reason should not be required.
export const wcWebhookFailures = pgTable('wc_webhook_failures', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: varchar('delivery_id', { length: 128 }),
  wcOrderId: varchar('wc_order_id', { length: 64 }),
  reason: varchar('reason', { length: 64 }).notNull(),
  payload: jsonb('payload').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => staff.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WcWebhookFailure = typeof wcWebhookFailures.$inferSelect;
export type NewWcWebhookFailure = typeof wcWebhookFailures.$inferInsert;
