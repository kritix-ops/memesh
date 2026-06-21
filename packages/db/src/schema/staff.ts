import { sql } from 'drizzle-orm';
import { boolean, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const staffRoleEnum = pgEnum('staff_role', ['admin', 'manager', 'cashier']);

export const staff = pgTable(
  'staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firstName: varchar('first_name', { length: 80 }).notNull(),
    lastName: varchar('last_name', { length: 80 }).notNull(),
    // Contact + unique business id. Was the login identifier until 2026-06-21;
    // login moved to email so the credential survives a phone change. Phone is
    // still unique (one staff row per number) and still mandatory.
    phone: varchar('phone', { length: 32 }).notNull().unique(),
    // Login identifier for admin and manager roles. Required at the route layer
    // for those roles (cashier may still have no email because their till-side
    // attribution uses a PIN, not a web login). Indexed unique on lower(email)
    // via the partial expression index below — case-insensitive matches Gmail-
    // style addresses without breaking display casing.
    email: varchar('email', { length: 255 }),
    passwordHash: varchar('password_hash', { length: 255 }), // scrypt; null until a credential is set
    role: staffRoleEnum('role').notNull().default('cashier'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive uniqueness on email. Partial (WHERE email IS NOT NULL)
    // so existing cashier rows without an email do not collide on the
    // canonical NULL value. The login route looks up by lower(email) so the
    // index also satisfies the hot path.
    uniqueIndex('staff_email_lower_unique')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} IS NOT NULL`),
  ],
);

export type Staff = typeof staff.$inferSelect;
export type NewStaff = typeof staff.$inferInsert;
