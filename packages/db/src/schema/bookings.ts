import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { punchCards } from './punch-cards';
import { roundInstances } from './round-instances';
import { ticketTypeEnum } from './rounds';

// Where the booking's payment came from. Drives refund + cancellation
// logic — punchcard cancellations refund a punch, paid cancellations
// trigger a WC refund, gift cancellations follow the recipient/buyer
// branch.
export const bookingSourceEnum = pgEnum('booking_source', [
  'paid',
  'punchcard',
  'gift',
  'manual',
]);

// State machine: created → held (TTL active) → confirmed (barcode minted) →
// used (scanned at the door). Or held → expired when TTL passes without
// payment. Or confirmed → cancelled (≥24h before round per Yanay's rule).
// `used` is terminal; no further transitions.
export const bookingStatusEnum = pgEnum('booking_status', [
  'held',
  'confirmed',
  'used',
  'cancelled',
  'expired',
]);

// Customer-to-round-instance assignment. A held booking with hold_expires_at
// in the future occupies a slot but isn't yet a confirmed reservation —
// expiry returns the slot to the pool. Confirmed bookings carry a
// HMAC-signed barcode_token that the door scanner verifies and burns to
// 'used' on entry.
export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundInstanceId: uuid('round_instance_id')
      .notNull()
      .references(() => roundInstances.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    ticketType: ticketTypeEnum('ticket_type').notNull(),
    // 0 or 1 in practice per Yanay's `additional_companion_max_per_child`
    // setting (default 1). The schema allows higher values for future
    // policy flexibility; the API enforces the per-child cap.
    additionalCompanions: smallint('additional_companions').notNull().default(0),
    source: bookingSourceEnum('source').notNull(),
    status: bookingStatusEnum('status').notNull(),
    // Human-friendly ticket number R-YYYYMMDD-NNNN — the manual fallback at
    // the door when the QR isn't scanned, same role the serial plays on punch
    // cards. Assigned at creation on the real paths (hold / punch booking);
    // nullable because legacy rows are backfilled by migration and test
    // fixtures insert rows directly.
    bookingNumber: varchar('booking_number', { length: 20 }).unique(),
    // Minted only on transition to 'confirmed'. UNIQUE so a single barcode
    // resolves to exactly one booking at the scanner. Null for
    // held/expired/cancelled rows.
    barcodeToken: varchar('barcode_token', { length: 128 }).unique(),
    // Monotonic barcode version, signed into the token. A swap bumps this and
    // re-mints, so an old screenshotted QR from before the swap fails at the
    // door (the scanner checks the current version). Starts at 1.
    barcodeVersion: smallint('barcode_version').notNull().default(1),
    // Set only when status = 'held'. NULL once the booking transitions out.
    // Cleanup job runs every minute over the partial index covering this
    // column where status = 'held'.
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    // Matches the punch_cards.wc_order_id shape (varchar not integer) so
    // reports can join on a single column type.
    wcOrderId: varchar('wc_order_id', { length: 64 }),
    // The actual amount (₪, incl. VAT) charged for this booking's entrance-ticket
    // line, snapshotted from the WooCommerce order at mint time. cancelBooking
    // refunds THIS for the ticket portion instead of a value recomputed from
    // current price settings, so a later WP price change can't skew a refund. The
    // additional-companion add-on stays settings-derived (companion lines carry
    // no hold id and aren't reliably attributable per booking in the webhook
    // payload). Null for bookings minted before this column existed (they fall
    // back to the settings ticket price) and for non-WC sources (punch/gift).
    paidTicketIls: integer('paid_ticket_ils'),
    // Idempotency key for the WooCommerce checkout hold (super-brief §4.2).
    // WooCommerce re-creates order line items on every checkout attempt, and a
    // single cart can now carry several children on the SAME round (Yanay
    // 2026-07-07). The reuse match keys on this per-line token (the cart line's
    // memesh_uid), so a payment retry refreshes that line's own hold while two
    // different children on one round each get their own seat. Null on every
    // non-WC path.
    holdKey: varchar('hold_key', { length: 64 }),
    // Set when source = 'punchcard' — points to the card that paid for
    // this booking, used on cancellation to refund the punch.
    punchCardId: uuid('punch_card_id').references(() => punchCards.id),
    // Set when source = 'gift'. Snapshot of recipient details at order
    // time: { firstName, lastName, phone, email }. JSONB so support can
    // query without joining elsewhere.
    giftRecipient: jsonb('gift_recipient'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Dashboard availability + admin reports: count by (round_instance,
    // status). Composite index supports index-only scans for COUNT queries.
    index('bookings_round_instance_status_idx').on(table.roundInstanceId, table.status),
    // Customer personal area: "my upcoming bookings".
    index('bookings_customer_status_idx').on(table.customerId, table.status),
    // Cleanup job hot path. Partial index = only the rows that could
    // possibly need expiry. Kept tiny so the cron is cheap.
    index('bookings_hold_expires_idx')
      .on(table.holdExpiresAt)
      .where(sql`${table.status} = 'held'`),
    // Webhook idempotency: mint endpoint looks up by wc_order_id before
    // creating, so a re-delivered webhook returns the existing booking
    // instead of creating a duplicate.
    index('bookings_wc_order_idx').on(table.wcOrderId),
  ],
);

export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
