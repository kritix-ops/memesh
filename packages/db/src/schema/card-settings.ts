import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { staff } from './staff';

// Singleton: exactly one row, enforced by `singleton boolean UNIQUE DEFAULT true`.
// Adding `accountId` later for multi-tenant is a column add + index, no rewrite.
export const cardSettings = pgTable('card_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  singleton: boolean('singleton').notNull().default(true).unique(),
  priceShekels: integer('price_shekels').notNull().default(320),
  validityDays: integer('validity_days').notNull().default(365),
  totalEntries: integer('total_entries').notNull().default(12),
  pitchLabel: text('pitch_label').notNull().default('משלמים על 10, מקבלים 12 · תקף לשנה'),
  updatedBy: uuid('updated_by').references(() => staff.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CardSettingsRow = typeof cardSettings.$inferSelect;
export type NewCardSettingsRow = typeof cardSettings.$inferInsert;
