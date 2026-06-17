import { integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// One-time login codes for the customer area. We store only an HMAC of the code
// (peppered with a server secret), never the code itself, so a DB leak does not
// reveal active codes. Rows are short-lived and single-use.
export const customerOtps = pgTable('customer_otps', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 32 }).notNull(),
  codeHash: varchar('code_hash', { length: 128 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CustomerOtp = typeof customerOtps.$inferSelect;
export type NewCustomerOtp = typeof customerOtps.$inferInsert;
