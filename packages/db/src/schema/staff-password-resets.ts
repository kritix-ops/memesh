import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { staff } from './staff';

/**
 * Single-use, short-lived password-reset tokens for staff (admin + manager
 * roles use this; cashier rows that have an email may also use it). Mirrors
 * `customer_login_tokens`:
 *   - We store only the SHA-256 hex of the raw token, never the token itself.
 *   - The raw token has 256 bits of entropy (crypto.randomBytes(32) →
 *     base64url) so brute-forcing within its lifetime is infeasible.
 *   - Single-use: consumedAt is set atomically by the consume endpoint
 *     (UPDATE ... WHERE consumed_at IS NULL RETURNING ...).
 *   - Short-lived: expiresAt is ~30 minutes from creation (longer than the
 *     handoff token because the user has to read an email, but still short
 *     enough to limit replay).
 *
 * On a successful reset, ALL other unconsumed tokens for the same staff id
 * are also burned (see `invalidateStaffPasswordResets` in the repo) — stops
 * a leaked-but-unused token from being weaponized after the legitimate user
 * beat the attacker to it.
 */
export const staffPasswordResets = pgTable('staff_password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id')
    .notNull()
    .references(() => staff.id, { onDelete: 'cascade' }),
  // SHA-256 hex of the raw token (64 chars). Indexed UNIQUE so the consume
  // endpoint can do an atomic UPDATE-WHERE-NULL by hash.
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type StaffPasswordReset = typeof staffPasswordResets.$inferSelect;
export type NewStaffPasswordReset = typeof staffPasswordResets.$inferInsert;
