import { confirmCompanionUpgrade, mintBooking } from '@memesh/db';
import type { KeyResolver } from '@memesh/qr-engine';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { z } from 'zod';

// Round side of the WooCommerce order webhook (super-brief §4.2). The card
// processor (wc-order-processor.ts) handles punch-card line items; this handles
// round line items. Each round line item carries the pre-payment hold id in its
// meta (`_memesh_hold_id`), so on a paid order we mint each held booking into a
// confirmed one. mintBooking is idempotent per hold id, so a re-delivered
// webhook (or the thank-you redirect racing the webhook) is a safe no-op.
//
// Kept separate from the card processor on purpose: different domain (bookings
// vs cards), different idempotency (per-hold vs per-delivery), and no reason to
// entangle the battle-tested card path.

type AnyPgDatabase = PgDatabase<any, any, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Line-item meta the WP checkout snippet attaches per round seat. We only need
// the hold id here; the round instance + ticket type are already on the held
// booking that hold id points to.
const HOLD_ID_KEY = '_memesh_hold_id';
// Order-level meta our own companion-checkout endpoint writes when it creates
// the ₪-companion order (plan 2026-07-02-punch-companion-upsell). A paid order
// carrying it upgrades the referenced punch booking's additional_companions.
const COMPANION_BOOKING_KEY = '_memesh_companion_booking_id';

const metaItemSchema = z.object({ key: z.string(), value: z.unknown() });
const lineItemSchema = z.object({ meta_data: z.array(metaItemSchema).optional() });
const orderSchema = z.object({
  id: z.number(),
  status: z.string(),
  line_items: z.array(lineItemSchema),
  meta_data: z.array(metaItemSchema).optional(),
});

const RELEVANT_TOPICS = new Set(['order.created', 'order.updated']);
const PAID_STATUSES = new Set(['completed', 'processing']);

const readMetaString = (
  meta: Array<{ key: string; value?: unknown }> | undefined,
  key: string,
): string | undefined => {
  if (!meta) return undefined;
  for (const m of meta) {
    if (m.key === key && typeof m.value === 'string') return m.value.trim();
  }
  return undefined;
};

export interface ProcessRoundOrderInput {
  topic: string;
  payload: unknown;
  resolver: KeyResolver;
  now?: Date;
}

export type ProcessRoundOrderResult =
  | { status: 'ignored_topic' }
  | { status: 'ignored_status'; orderStatus: string }
  | { status: 'invalid_payload' }
  | { status: 'no_round_items' }
  | {
      status: 'processed';
      orderId: string;
      /** Booking ids minted (or idempotently replayed) on this delivery. */
      minted: string[];
      /**
       * Holds that could not be minted for a REAL reason — a bad hold id, or a
       * seat that was taken while the customer paid (sold_out_after_payment).
       * These are genuine orphaned paid seats that need an operator refund.
       */
      failed: Array<{ holdId: string; error: string }>;
      /**
       * Holds whose booking was already cancelled when a webhook re-delivered.
       * This is expected and benign (the seat was booked then deliberately
       * cancelled) — kept separate from `failed` so it never triggers the
       * "paid seat with no booking" refund alarm.
       */
      alreadyCancelled: string[];
      /**
       * Companion-upgrade outcome when the order carried
       * `_memesh_companion_booking_id`. An error here is money for a dead or
       * mismatched booking — the caller logs it for an operator refund.
       */
      companion?: { bookingId: string; ok: boolean; replayed?: boolean; error?: string };
    };

/**
 * Mint every round booking on a paid WooCommerce order. Self-guards on topic +
 * paid status + payload shape so the webhook route can call it unconditionally
 * for a fresh delivery. Does not claim a delivery id (idempotency comes from
 * mintBooking being idempotent per hold id).
 */
export const processRoundOrderWebhook = async (
  db: AnyPgDatabase,
  input: ProcessRoundOrderInput,
): Promise<ProcessRoundOrderResult> => {
  if (!RELEVANT_TOPICS.has(input.topic)) return { status: 'ignored_topic' };
  const parsed = orderSchema.safeParse(input.payload);
  if (!parsed.success) return { status: 'invalid_payload' };
  const order = parsed.data;
  if (!PAID_STATUSES.has(order.status)) {
    return { status: 'ignored_status', orderStatus: order.status };
  }

  const orderId = String(order.id);
  const holdIds: string[] = [];
  for (const li of order.line_items) {
    const holdId = readMetaString(li.meta_data, HOLD_ID_KEY);
    if (holdId) holdIds.push(holdId);
  }
  const companionBookingId = readMetaString(order.meta_data, COMPANION_BOOKING_KEY);
  if (holdIds.length === 0 && !companionBookingId) return { status: 'no_round_items' };

  const minted: string[] = [];
  const failed: Array<{ holdId: string; error: string }> = [];
  const alreadyCancelled: string[] = [];
  for (const holdId of holdIds) {
    if (!UUID_RE.test(holdId)) {
      failed.push({ holdId, error: 'invalid_hold_id' });
      continue;
    }
    const res = await mintBooking(
      db,
      { holdId, wcOrderId: orderId, source: 'paid' },
      input.resolver,
      input.now,
    );
    if (res.ok) minted.push(res.booking.bookingId);
    // A cancelled booking is an expected webhook re-delivery, not an orphaned
    // paid seat — keep it out of `failed` so it never trips the refund alarm.
    else if (res.error === 'cancelled') alreadyCancelled.push(holdId);
    else failed.push({ holdId, error: res.error });
  }

  // Companion upsell: a paid order tagged with a booking id upgrades that
  // punch booking's additional_companions (idempotent per order id).
  let companion: { bookingId: string; ok: boolean; replayed?: boolean; error?: string } | undefined;
  if (companionBookingId) {
    if (!UUID_RE.test(companionBookingId)) {
      companion = { bookingId: companionBookingId, ok: false, error: 'invalid_booking_id' };
    } else {
      const res = await confirmCompanionUpgrade(
        db,
        { bookingId: companionBookingId, wcOrderId: orderId },
        input.now,
      );
      companion = res.ok
        ? { bookingId: companionBookingId, ok: true, replayed: res.replayed }
        : { bookingId: companionBookingId, ok: false, error: res.error };
    }
  }

  return {
    status: 'processed',
    orderId,
    minted,
    failed,
    alreadyCancelled,
    ...(companion ? { companion } : {}),
  };
};
