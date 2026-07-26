import type { KeyResolver } from '@memesh/qr-engine';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { processRoundOrderWebhook } from './wc-round-processor.js';

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
type AnyPgDatabase = PgDatabase<any, any, any>;

export interface ReconcileRoundBookingsDeps {
  /**
   * Fetch every PAID (processing + completed) WooCommerce order updated since
   * `since`, as raw WC order objects. Round tickets sit in `processing` for a
   * long time before an operator marks them completed, so — unlike the card
   * reconciliation (wc-reconciliation.ts) — this must NOT be limited to
   * `completed`. Returns the untouched WC JSON so processRoundOrderWebhook can
   * read each line item's `_memesh_hold_id` meta and its charged total.
   */
  listPaidOrdersSince: (since: Date) => Promise<unknown[]>;
  resolver: KeyResolver;
}

export interface ReconcileRoundBookingsOptions {
  lookbackHours: number;
  /** Override `now` for tests. */
  now?: Date;
}

export interface ReconcileRoundBookingsResult {
  ordersScanned: number;
  /**
   * Round holds confirmed on this pass. Includes idempotent replays — the DB
   * write is a no-op for a hold the live webhook already minted, so this counts
   * "seats we made sure are booked", not strictly "newly created".
   */
  bookingsMinted: number;
  /** Companion upsell orders healed on this pass (not counting replays). */
  companionUpgrades: number;
  /**
   * Paid seats that could NOT be minted — a bad hold id, or a seat taken while
   * the customer paid (sold_out_after_payment). Genuine orphaned paid seats
   * that need an operator refund. The alarm metric.
   */
  orphanedPaidSeats: number;
  lookbackHours: number;
}

/**
 * Round-booking half of the WC → API reconciliation safety net (mirrors
 * wc-reconciliation.ts, which heals cards). Runs on a per-minute Vercel Cron so
 * a paid round booking becomes staff-visible within ~60s even if the live order
 * webhook never arrives — the exact failure that stranded paid customers for
 * days when the WC webhook secret was cleared in WP admin (2026-07-26).
 *
 * Kept separate from the card reconciliation on purpose — the same split as the
 * webhook processors (wc-round-processor vs wc-order-processor): different
 * domain (bookings vs cards), different fetch (paid = processing+completed, not
 * completed-only), and no reason to entangle the battle-tested card path.
 *
 * Idempotent: processRoundOrderWebhook mints per hold id, and mintBooking is a
 * no-op for a hold that's already confirmed, so re-running every minute is safe
 * and races the live webhook cleanly (mintBooking's row lock serialises them).
 */
export const reconcileRoundBookings = async (
  db: AnyPgDatabase,
  deps: ReconcileRoundBookingsDeps,
  opts: ReconcileRoundBookingsOptions,
): Promise<ReconcileRoundBookingsResult> => {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.lookbackHours * 60 * 60 * 1000);

  const orders = await deps.listPaidOrdersSince(since);

  let bookingsMinted = 0;
  let companionUpgrades = 0;
  let orphanedPaidSeats = 0;

  for (const order of orders) {
    const result = await processRoundOrderWebhook(db, {
      topic: 'order.updated',
      payload: order,
      resolver: deps.resolver,
      ...(opts.now && { now: opts.now }),
    });
    if (result.status === 'processed') {
      bookingsMinted += result.minted.length;
      orphanedPaidSeats += result.failed.length;
      if (result.companion && result.companion.ok && !result.companion.replayed) {
        companionUpgrades += 1;
      }
    }
  }

  return {
    ordersScanned: orders.length,
    bookingsMinted,
    companionUpgrades,
    orphanedPaidSeats,
    lookbackHours: opts.lookbackHours,
  };
};
