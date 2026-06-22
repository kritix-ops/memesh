import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { customers } from './customers';

/**
 * Single-use, short-lived login tokens for the customer area. Minters:
 *   - WooCommerce checkout-handoff (see apps/api/src/routes/wc-handoff.ts):
 *     after a successful purchase WordPress requests a token for the buying
 *     customer and redirects to my.memesh.co.il with that token so the
 *     customer is signed in immediately, no OTP step. 5-minute TTL.
 *   - POS card sale (see apps/api/src/routes/cards.ts): the cashier creates
 *     a card and the post-sale SMS embeds a magic link with this token so
 *     the customer can tap straight into their personal area, no OTP step.
 *     24-hour TTL — SMS may sit unread for hours.
 *
 * Security shape mirrors customer_otps:
 *   - We store only the SHA-256 of the raw token, never the token itself.
 *   - Single-use: consumedAt is set atomically by the verify endpoint
 *     (UPDATE ... WHERE consumed_at IS NULL RETURNING ...).
 *   - Short-lived: expiresAt set per-source via the caller's ttlMs.
 *   - The raw token has 256 bits of entropy (crypto.randomBytes(32) →
 *     base64url) so brute-forcing within its lifetime is infeasible.
 *
 * orderRef is the per-source audit pointer: WooCommerce order id for
 * 'wc_checkout', card id for 'pos_sell'. The verify path does not check it.
 */
export const customerLoginTokens = pgTable('customer_login_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  // SHA-256 hex of the raw token (64 chars). Indexed UNIQUE so the verify
  // endpoint can do an atomic SELECT-FOR-UPDATE / UPDATE-WHERE-NULL by hash.
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  // 'wc_checkout' | 'pos_sell' today; future sources get distinct values so
  // we can audit and rate-limit per source independently.
  source: varchar('source', { length: 40 }).notNull(),
  // Per-source audit pointer. WooCommerce order id when source='wc_checkout';
  // card id when source='pos_sell'. The verify path does not check this.
  orderRef: varchar('order_ref', { length: 64 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CustomerLoginToken = typeof customerLoginTokens.$inferSelect;
export type NewCustomerLoginToken = typeof customerLoginTokens.$inferInsert;
