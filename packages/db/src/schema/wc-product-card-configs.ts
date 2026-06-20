import { boolean, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Maps a WooCommerce product SKU to the punch-card spec that should be minted
// when that SKU is purchased online. v1 seeds a single row for SKU 1004; new
// products are added as rows without code changes.
//
// validityDays mirrors the card_settings sentinel: `null` = forever (no
// expiry), positive int = days from purchase. Matches the same convention as
// punch_cards.expiresAt and the admin card-control flow.
export const wcProductCardConfigs = pgTable('wc_product_card_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  wcSku: varchar('wc_sku', { length: 64 }).notNull().unique(),
  totalEntries: integer('total_entries').notNull(),
  validityDays: integer('validity_days'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WcProductCardConfig = typeof wcProductCardConfigs.$inferSelect;
export type NewWcProductCardConfig = typeof wcProductCardConfigs.$inferInsert;
