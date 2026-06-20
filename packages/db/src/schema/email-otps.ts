import { index, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Email-based one-time login codes for the customer area. Mirrors
// `customer_otps` but keyed by email instead of phone. Used as a fallback
// when SMS fails or the customer has changed their phone number — the email
// must match an existing `customers.email` exactly; we never reveal whether
// an email is on file. Codes are HMAC-hashed with SERVER_SECRET_KEY, never
// stored in plaintext.
export const emailOtps = pgTable(
  'email_otps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull(),
    codeHash: varchar('code_hash', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Hot path: lookup the latest unconsumed OTP for an email, and rate-limit
    // checks scan the last N rows for the same email. Without the index this
    // becomes a full table scan once the table grows past a few thousand
    // rows of historical OTPs.
    index('email_otps_email_created_at_idx').on(table.email, table.createdAt),
  ],
);

export type EmailOtp = typeof emailOtps.$inferSelect;
export type NewEmailOtp = typeof emailOtps.$inferInsert;
