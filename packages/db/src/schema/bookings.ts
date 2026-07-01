import { sql } from 'drizzle-orm';
import {
  index,
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
