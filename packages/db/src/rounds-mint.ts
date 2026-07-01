// Mint: turn a held booking into a confirmed one with a signed barcode
// (super-brief §4.2). Idempotent by holdId — the FOR UPDATE on the booking row
// serializes concurrent mint calls (e.g. the WC webhook and the thank-you
// redirect both firing), so the first confirms and the rest return the existing
// booking. Handles the hold-expired-during-payment case by re-checking room.

import { and, count, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { signBookingToken, type KeyResolver } from '@memesh/qr-engine';
import { markWaitlistClaimed } from './rounds-waitlist';
import { bookings, roundInstances } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type MintBookingInput = {
  /** The held booking's id (returned by createHold). */
  holdId: string;
  /** Stamped on the booking when the mint comes from a WooCommerce order. */
  wcOrderId?: string;
  /** Overrides the provisional hold source (e.g. 'punchcard'). */
  source?: 'paid' | 'punchcard' | 'gift' | 'manual';
  /**
   * When set, the hold must belong to this customer or the mint is rejected.
   * Used by customer-initiated confirmation (the dev-pay stub); the real WC
   * webhook path is server-to-server and leaves it unset.
   */
  expectedCustomerId?: string;
};

export type MintedBooking = {
  bookingId: string;
  barcodeToken: string;
  status: 'confirmed';
};

export type MintBookingResult =
  | { ok: true; booking: MintedBooking; idempotentReplay: boolean }
  | { ok: false; error: 'not_found' | 'forbidden' | 'sold_out_after_payment' };

export const mintBooking = async (
  db: AnyPgDatabase,
  input: MintBookingInput,
  resolver: KeyResolver,
  now: Date = new Date(),
): Promise<MintBookingResult> => {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(bookings).where(eq(bookings.id, input.holdId)).for('update');
    const booking = rows[0];
    if (!booking) return { ok: false, error: 'not_found' as const };
    if (input.expectedCustomerId && booking.customerId !== input.expectedCustomerId) {
      return { ok: false, error: 'forbidden' as const };
    }

    // Idempotent replay: already minted.
    if (booking.status === 'confirmed' || booking.status === 'used') {
      const tok = booking.barcodeToken;
      if (!tok) throw new Error('[rounds-mint] confirmed booking missing barcode');
      return {
        ok: true,
        booking: { bookingId: booking.id, barcodeToken: tok, status: 'confirmed' as const },
        idempotentReplay: true,
      };
    }
    // A cancelled booking can't be minted.
    if (booking.status === 'cancelled') return { ok: false, error: 'not_found' as const };

    // If the hold is no longer active (expired by TTL or swept), re-check that a
    // seat is still free before confirming (hold-expired-during-payment, §4.2).
    const holdValid =
      booking.status === 'held' &&
      booking.holdExpiresAt !== null &&
      new Date(booking.holdExpiresAt).getTime() > now.getTime();
    if (!holdValid) {
      const instRows = await tx
        .select({ capacity: roundInstances.capacity, isClosed: roundInstances.isClosed })
        .from(roundInstances)
        .where(eq(roundInstances.id, booking.roundInstanceId))
        .for('update');
      const inst = instRows[0];
      if (!inst || inst.isClosed) return { ok: false, error: 'sold_out_after_payment' as const };
      // This booking is expired, so it isn't in `taken`; we need room for it.
      const takenRows = await tx
        .select({ n: count() })
        .from(bookings)
        .where(
          and(
            eq(bookings.roundInstanceId, booking.roundInstanceId),
            sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
          ),
        );
      if (Number(takenRows[0]?.n ?? 0) + 1 > inst.capacity) {
        return { ok: false, error: 'sold_out_after_payment' as const };
      }
    }

    const token = signBookingToken({ bookingId: booking.id, version: booking.barcodeVersion }, resolver);
    const updated = await tx
      .update(bookings)
      .set({
        status: 'confirmed',
        barcodeToken: token,
        confirmedAt: now,
        holdExpiresAt: null,
        ...(input.wcOrderId ? { wcOrderId: input.wcOrderId } : {}),
        ...(input.source ? { source: input.source } : {}),
        updatedAt: now,
      })
      .where(eq(bookings.id, booking.id))
      .returning({ id: bookings.id, barcodeToken: bookings.barcodeToken });
    const b = updated[0];
    if (!b || !b.barcodeToken) throw new Error('[rounds-mint] confirm returned no barcode');
    // If this customer was on the waitlist for this round, the booking closes
    // their offer.
    await markWaitlistClaimed(tx, booking.roundInstanceId, booking.customerId, now);
    return {
      ok: true,
      booking: { bookingId: b.id, barcodeToken: b.barcodeToken, status: 'confirmed' as const },
      idempotentReplay: false,
    };
  });
};
