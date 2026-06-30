import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { punchCards } from './punch-cards';

// Holds a "this WC order is a gift, the recipient hasn't claimed it yet" row.
// Lifecycle:
//   1. WC webhook receives a gift order whose recipient phone/email match NO
//      existing customer → row inserted, claim email sent
//   2. Recipient clicks the magic link, verifies their phone via OTP → row's
//      `claimed_at` + `minted_card_id` populated, customer + punch card created
//   3. Daily cron sweeps rows past `expires_at` (default 365 days) and sets
//      `expired_at`. Buyer is emailed a "your gift was not claimed" notice.
// Rows are intentionally NOT deleted on claim/expire — kept for audit so a
// support agent can trace what happened months later.
export const giftPendingClaims = pgTable(
  'gift_pending_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // WC order this gift belongs to. Not a FK because WC orders are external,
    // but indexed for the reconciliation path + admin lookup.
    wcOrderId: varchar('wc_order_id', { length: 64 }).notNull(),
    // The matched product SKU — needed at claim time to know what kind of
    // card to mint (entries + validity days come from wc_product_card_configs).
    wcSku: varchar('wc_sku', { length: 64 }).notNull(),

    // Buyer details denormalized onto the row. The buyer may never become a
    // Memesh customer, so we cannot rely on a FK to `customers`. These are
    // the source of truth for the buyer-side emails (initial confirmation +
    // claim notification).
    buyerFirstName: text('buyer_first_name').notNull(),
    buyerLastName: text('buyer_last_name').notNull(),
    buyerEmail: text('buyer_email').notNull(),
    buyerPhone: varchar('buyer_phone', { length: 32 }).notNull(),

    // Recipient details as the buyer entered them at WC checkout. Source of
    // truth for the gift identity until the recipient claims and becomes a
    // customer of their own.
    recipientFirstName: text('recipient_first_name').notNull(),
    recipientLastName: text('recipient_last_name').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    recipientPhone: varchar('recipient_phone', { length: 32 }).notNull(),

    // sha256 hex of the raw claim token. The raw value lives only in the
    // recipient email — server stores the hash, same model as handoff_tokens.
    // Single-use semantics enforced at the route layer.
    claimTokenHash: varchar('claim_token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    // Set when claim succeeds. Until then admin can re-email the claim link.
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    // FK to the punch card minted on claim. Null until claimed.
    mintedCardId: uuid('minted_card_id').references(() => punchCards.id),
    // Set by the daily expiry-sweep cron when expires_at < now and claimed_at
    // is still null. Kept separate from expires_at so the original deadline
    // stays visible for audits.
    expiredAt: timestamp('expired_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reconciliation lookup: "is there a pending gift for WC order X?" — same
    // shape the existing wc_processed_webhooks idempotency relies on.
    index('gift_pending_claims_wc_order_id_idx').on(table.wcOrderId),
    // Claim-flow phone-match: when the recipient enters their phone at the
    // claim page we look up the pending row by recipient phone (+ token hash).
    index('gift_pending_claims_recipient_phone_idx').on(table.recipientPhone),
    // Cron expiry sweep scans unclaimed rows by expires_at < now.
    index('gift_pending_claims_expires_at_idx').on(table.expiresAt),
  ],
);

export type GiftPendingClaim = typeof giftPendingClaims.$inferSelect;
export type NewGiftPendingClaim = typeof giftPendingClaims.$inferInsert;
