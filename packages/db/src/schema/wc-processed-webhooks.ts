import { pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

// Idempotency log for inbound WooCommerce webhooks. Each WC delivery sends an
// X-WC-Webhook-Delivery-ID header which we record here inside the same
// transaction that creates the cards. A second delivery with the same id is
// rejected at insert time (primary key conflict) and the handler returns 200
// without touching anything else.
export const wcProcessedWebhooks = pgTable('wc_processed_webhooks', {
  deliveryId: varchar('delivery_id', { length: 128 }).primaryKey(),
  wcOrderId: varchar('wc_order_id', { length: 64 }).notNull(),
  topic: varchar('topic', { length: 64 }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WcProcessedWebhook = typeof wcProcessedWebhooks.$inferSelect;
export type NewWcProcessedWebhook = typeof wcProcessedWebhooks.$inferInsert;
