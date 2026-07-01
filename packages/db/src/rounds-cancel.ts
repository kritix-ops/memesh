// Cancel a confirmed booking with a refund (super-brief §6.2). Money-safety is
// the whole point: the seat is released ONLY after the refund is confirmed. If
// the refund can't be confirmed, we don't cancel — the customer keeps their
// paid seat and can retry. The refund is injected so this stays free of the WC
// client; it runs inside the transaction under the booking's row lock, which
// serializes concurrent cancels (no double refund) at the cost of holding the
// lock for the refund's duration — fine at a single venue's volume.

import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getCardSettings } from './card-settings';
import { getRoundSettings } from './round-settings';
import { isWithinCancelWindow } from './round-time';
import { bookings, punchCardEntries, punchCards, roundInstances, rounds } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type CancelBookingInput = {
  bookingId: string;
  customerId: string;
};

export type CancelBookingDeps = {
  /**
   * Refund `amountIls` against `wcOrderId`. Must return true ONLY when the
   * refund is confirmed. Injected so the DB layer never imports the WC client.
   */
  refund: (wcOrderId: string, amountIls: number) => Promise<boolean>;
};

export type CancelBookingResult =
  | { ok: true; refunded: boolean; punchReturned: boolean; refundAmountIls: number }
  | { ok: false; error: 'not_found' | 'forbidden' | 'not_confirmed' | 'too_late' | 'refund_failed' };

const hhmm = (t: string): string => t.slice(0, 5);

export const cancelBooking = async (
  db: AnyPgDatabase,
  input: CancelBookingInput,
  deps: CancelBookingDeps,
  now: Date = new Date(),
): Promise<CancelBookingResult> => {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: bookings.id,
        customerId: bookings.customerId,
        status: bookings.status,
        source: bookings.source,
        wcOrderId: bookings.wcOrderId,
        ticketType: bookings.ticketType,
        additionalCompanions: bookings.additionalCompanions,
        date: roundInstances.date,
        startTime: rounds.startTime,
      })
      .from(bookings)
      .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
      .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
      .where(eq(bookings.id, input.bookingId))
      .for('update');
    const b = rows[0];
    if (!b) return { ok: false, error: 'not_found' as const };
    if (b.customerId !== input.customerId) return { ok: false, error: 'forbidden' as const };
    if (b.status !== 'confirmed') return { ok: false, error: 'not_confirmed' as const };

    const roundSettings = await getRoundSettings(tx);
    if (!isWithinCancelWindow(b.date, hhmm(b.startTime), roundSettings.cancellationWindowHours, now)) {
      return { ok: false, error: 'too_late' as const };
    }

    let refunded = false;
    let punchReturned = false;
    let refundAmountIls = 0;

    if (b.source === 'paid') {
      // Paid bookings must have a confirmed refund before the seat is released.
      // Refund value = ticket price by type + companions × companion price.
      if (!b.wcOrderId) return { ok: false, error: 'refund_failed' as const };
      const cardSettings = await getCardSettings(tx);
      const ticketPrice =
        b.ticketType === 'child_under_walking'
          ? cardSettings.roundChildBabyPriceIls
          : cardSettings.roundChildOverWalkingPriceIls;
      refundAmountIls = ticketPrice + b.additionalCompanions * cardSettings.roundAdditionalCompanionPriceIls;
      refunded = await deps.refund(b.wcOrderId, refundAmountIls);
      if (!refunded) return { ok: false, error: 'refund_failed' as const };
    } else if (b.source === 'punchcard') {
      // Return the entry we spent: find it by the booking-id link, mark it
      // refunded, restore the card's used count, and reactivate the card if
      // exhaustion had deactivated it. No money moves.
      const entryRows = await tx
        .select()
        .from(punchCardEntries)
        .where(eq(punchCardEntries.idempotencyKey, b.id));
      const entry = entryRows[0];
      if (entry && entry.refundedAt === null) {
        const cardRows = await tx
          .select()
          .from(punchCards)
          .where(eq(punchCards.id, entry.punchCardId))
          .for('update');
        const card = cardRows[0];
        if (card) {
          const restored = Math.max(0, card.usedEntries - entry.entriesConsumed);
          const reactivate = !card.isActive && card.cancelledAt === null;
          await tx
            .update(punchCardEntries)
            .set({ refundedAt: now, refundReason: 'round booking cancelled' })
            .where(eq(punchCardEntries.id, entry.id));
          await tx
            .update(punchCards)
            .set({ usedEntries: restored, ...(reactivate && { isActive: true }), updatedAt: now })
            .where(eq(punchCards.id, card.id));
          punchReturned = true;
        }
      }
    }
    // (gift/manual sources don't exist in the v1 flow; gift refund lands with §7.)

    await tx.update(bookings).set({ status: 'cancelled', updatedAt: now }).where(eq(bookings.id, b.id));
    // Waitlist promotion on the freed seat lands with the waitlist PR.
    return { ok: true as const, refunded, punchReturned, refundAmountIls };
  });
};
