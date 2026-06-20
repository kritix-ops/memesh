import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { staff } from './staff';

export const preferredChannelEnum = pgEnum('preferred_channel', ['sms', 'whatsapp', 'email']);
export const customerSourceEnum = pgEnum('customer_source', [
  'referral',
  'social',
  'walk_by',
  'website',
  'other',
]);
export const customerStatusEnum = pgEnum('customer_status', ['active', 'frozen', 'vip']);

export interface ChildRecord {
  name: string;
  dob: string; // ISO yyyy-mm-dd
  notes?: string;
}

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerNumber: varchar('customer_number', { length: 16 }).notNull().unique(), // L-NNNN
  wpUserId: integer('wp_user_id'),
  firstName: varchar('first_name', { length: 80 }).notNull(),
  lastName: varchar('last_name', { length: 80 }).notNull(),
  phone: varchar('phone', { length: 32 }).notNull().unique(), // also the login identifier
  email: varchar('email', { length: 255 }),
  preferredChannel: preferredChannelEnum('preferred_channel').notNull().default('sms'),
  children: jsonb('children').$type<ChildRecord[]>().notNull().default([]),
  internalNotes: text('internal_notes'), // staff only, never shown to the customer
  source: customerSourceEnum('source'),
  status: customerStatusEnum('status').notNull().default('active'),
  marketingConsentAt: timestamp('marketing_consent_at', { withTimezone: true }),
  registeredBy: uuid('registered_by').references(() => staff.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
