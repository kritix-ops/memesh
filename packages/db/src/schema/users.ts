import { integer, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', [
  'customer',
  'cashier',
  'instructor',
  'manager',
  'admin',
]);

export interface ChildRecord {
  name: string;
  dob: string;
  notes?: string;
}

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  wpUserId: integer('wp_user_id'),
  firstName: varchar('first_name', { length: 80 }).notNull(),
  lastName: varchar('last_name', { length: 80 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  phone: varchar('phone', { length: 32 }),
  role: userRoleEnum('role').notNull().default('customer'),
  children: jsonb('children').$type<ChildRecord[]>(),
  childrenConsentAt: timestamp('children_consent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
