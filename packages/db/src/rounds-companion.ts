// Paid extra companion (מלווה נוסף) for punch-card bookings — the personal-area
// upsell (plan 2026-07-02-punch-companion-upsell). Companions never consume
// round capacity (super-brief: "נספרים רק כרטיסי ילד"), so there is no hold
// here: the API creates a pending WooCommerce order for the companion fee and
// the paid-order webhook calls confirmCompanionUpgrade to flip the booking's
// additional_companions 0 → 1. The pending order id is stamped onto the
// booking's wc_order_id (free for punchcard rows) so retries reuse the same
// order and cancellation knows what to refund.

import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getCardSettings } from './card-settings';
import { bookings, roundInstances, rounds } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type PrepareCompanionCheckoutInput = {
  bookingId: string;
  customerId: string;
};

export type PrepareCompanionCheckoutResult =
  | {
      ok: true;
      booking: {
        id: string;
        /** Existing pending/paid companion order, if a checkout already started. */
        wcOrderId: string | null;
        additionalCompanions: number;
        roundLabel: string;
        /** YYYY-MM-DD */
        date: string;
        /** "HH:MM" */
        startTime: string;
      };
      priceIls: number;
    }
  | {
      ok: false;
      error: 'not_found' | 'forbidden' | 'not_punchcard' | 'not_confirmed' | 'already_has_companion';
    };

/**
 * Validate that a booking can take a paid extra companion and return what the
 * checkout needs: round display data for the WC fee-line label, the current
 * companion price, and any previously created order id (retry path).
 */
export const prepareCompanionCheckout = async (
  db: AnyPgDatabase,
  input: PrepareCompanionCheckoutInput,
): Promise<PrepareCompanionCheckoutResult> => {
  const rows = await db
    .select({
      id: bookings.id,
      customerId: bookings.customerId,
      source: bookings.source,
      status: bookings.status,
      additionalCompanions: bookings.additionalCompanions,
      wcOrderId: bookings.wcOrderId,
      roundLabel: rounds.displayName,
      date: roundInstances.date,
      startTime: rounds.startTime,
    })
    .from(bookings)
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(eq(bookings.id, input.bookingId))
    .limit(1);
  const b = rows[0];
  if (!b) return { ok: false, error: 'not_found' as const };
  if (b.customerId !== input.customerId) return { ok: false, error: 'forbidden' as const };
  if (b.source !== 'punchcard') return { ok: false, error: 'not_punchcard' as const };
  if (b.status !== 'confirmed') return { ok: false, error: 'not_confirmed' as const };
  if (b.additionalCompanions > 0) return { ok: false, error: 'already_has_companion' as const };

  const settings = await getCardSettings(db);
  return {
    ok: true as const,
    booking: {
      id: b.id,
      wcOrderId: b.wcOrderId,
      additionalCompanions: b.additionalCompanions,
      roundLabel: b.roundLabel,
      date: b.date,
      startTime: b.startTime.slice(0, 5),
    },
    priceIls: settings.roundAdditionalCompanionPriceIls,
  };
};

/**
 * Stamp the pending WC companion order onto the booking so retries reuse it
 * and cancellation can refund it. Guarded to the punchcard/no-companion state
 * so a racing webhook confirmation is never overwritten backwards.
 */
export const recordCompanionOrder = async (
  db: AnyPgDatabase,
  input: { bookingId: string; wcOrderId: string },
  now: Date = new Date(),
): Promise<{ ok: boolean }> => {
  const updated = await db
    .update(bookings)
    .set({ wcOrderId: input.wcOrderId, updatedAt: now })
    .where(eq(bookings.id, input.bookingId))
    .returning({ id: bookings.id });
  return { ok: updated.length > 0 };
};

export type ConfirmCompanionUpgradeResult =
  | { ok: true; replayed: boolean }
  | { ok: false; error: 'not_found' | 'booking_cancelled' | 'order_mismatch' };

/**
 * Flip additional_companions 0 → 1 when the companion order is paid. Called
 * from the WC order processor (webhook + thank-you handoff — both paths).
 * Idempotent per order id: a re-delivered webhook replays as a no-op. A paid
 * order landing on a cancelled/expired booking is money for a dead seat —
 * returned as an error so the caller logs it for an operator refund (same
 * convention as mint_failed).
 */
export const confirmCompanionUpgrade = async (
  db: AnyPgDatabase,
  input: { bookingId: string; wcOrderId: string },
  now: Date = new Date(),
): Promise<ConfirmCompanionUpgradeResult> => {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: bookings.id,
        status: bookings.status,
        additionalCompanions: bookings.additionalCompanions,
        wcOrderId: bookings.wcOrderId,
      })
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .for('update');
    const b = rows[0];
    if (!b) return { ok: false, error: 'not_found' as const };
    if (b.status === 'cancelled' || b.status === 'expired') {
      return { ok: false, error: 'booking_cancelled' as const };
    }
    if (b.additionalCompanions > 0) {
      // Already upgraded. Same order → idempotent replay; a different order
      // means two payments reached one booking — surface it, never silently
      // absorb a double charge.
      if (b.wcOrderId === input.wcOrderId) return { ok: true as const, replayed: true };
      return { ok: false, error: 'order_mismatch' as const };
    }
    await tx
      .update(bookings)
      .set({ additionalCompanions: 1, wcOrderId: input.wcOrderId, updatedAt: now })
      .where(eq(bookings.id, b.id));
    return { ok: true as const, replayed: false };
  });
};
