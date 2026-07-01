// Book a round seat by spending a punch-card entry (super-brief §3.4). Same
// oversell guard as the paid hold, but instead of a WooCommerce payment the
// booking is confirmed immediately against one entry on the customer's OWN
// card. It all runs in one transaction — reserve the seat, mint the barcode,
// punch the card — so there is never a spent punch without a booking, or a
// booking without a spent punch. The door same-day lockout in punchCard() is a
// door concept and would wrongly block advance bookings, so the punch is
// written inline here (method 'online', punched_by null, no lockout). The
// entry's idempotency_key is the booking id, which is the link cancellation
// uses to find and reverse this exact punch.

import { and, count, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { signBookingToken, type KeyResolver } from '@memesh/qr-engine';
import { markWaitlistClaimed } from './rounds-waitlist';
import { bookings, punchCardEntries, punchCards, roundInstances } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type BookRoundWithPunchInput = {
  roundInstanceId: string;
  customerId: string;
  punchCardId: string;
  ticketType: 'child_under_walking' | 'child_over_walking';
};

export type BookRoundWithPunchResult =
  | { ok: true; bookingId: string; barcodeToken: string; remaining: number }
  | {
      ok: false;
      error:
        | 'round_not_found'
        | 'round_closed'
        | 'round_full'
        | 'card_not_found'
        | 'card_forbidden'
        | 'card_inactive'
        | 'card_expired'
        | 'card_exhausted';
    };

export const bookRoundWithPunch = async (
  db: AnyPgDatabase,
  input: BookRoundWithPunchInput,
  resolver: KeyResolver,
  now: Date = new Date(),
): Promise<BookRoundWithPunchResult> => {
  return db.transaction(async (tx) => {
    // 1. Lock the round instance and recount taken — the same oversell guard as
    // createHold. Companions never count toward capacity.
    const instRows = await tx
      .select({
        id: roundInstances.id,
        capacity: roundInstances.capacity,
        isClosed: roundInstances.isClosed,
      })
      .from(roundInstances)
      .where(eq(roundInstances.id, input.roundInstanceId))
      .for('update');
    const inst = instRows[0];
    if (!inst) return { ok: false, error: 'round_not_found' as const };
    if (inst.isClosed) return { ok: false, error: 'round_closed' as const };

    const takenRows = await tx
      .select({ n: count() })
      .from(bookings)
      .where(
        and(
          eq(bookings.roundInstanceId, input.roundInstanceId),
          sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
        ),
      );
    if (Number(takenRows[0]?.n ?? 0) + 1 > inst.capacity) {
      return { ok: false, error: 'round_full' as const };
    }

    // 2. Lock the card and validate: owned by this customer, active, not
    // expired (hard expiry — no door grace for advance bookings), has an entry.
    const cardRows = await tx
      .select()
      .from(punchCards)
      .where(eq(punchCards.id, input.punchCardId))
      .for('update');
    const cardRow = cardRows[0];
    if (!cardRow) return { ok: false, error: 'card_not_found' as const };
    if (cardRow.customerId !== input.customerId) return { ok: false, error: 'card_forbidden' as const };
    if (!cardRow.isActive) return { ok: false, error: 'card_inactive' as const };
    if (cardRow.expiresAt !== null && cardRow.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, error: 'card_expired' as const };
    }
    if (cardRow.usedEntries >= cardRow.totalEntries) {
      return { ok: false, error: 'card_exhausted' as const };
    }

    // 3. Insert the confirmed booking, then sign its barcode (needs the id).
    const insertedBooking = await tx
      .insert(bookings)
      .values({
        roundInstanceId: input.roundInstanceId,
        customerId: input.customerId,
        ticketType: input.ticketType,
        additionalCompanions: 0,
        source: 'punchcard',
        status: 'confirmed',
        punchCardId: cardRow.id,
        confirmedAt: now,
        updatedAt: now,
      })
      .returning({ id: bookings.id, barcodeVersion: bookings.barcodeVersion });
    const booking = insertedBooking[0];
    if (!booking) throw new Error('[rounds-punch] booking insert returned no row');

    const token = signBookingToken({ bookingId: booking.id, version: booking.barcodeVersion }, resolver);
    await tx.update(bookings).set({ barcodeToken: token }).where(eq(bookings.id, booking.id));

    // 4. Punch the card inline (no door lockout). idempotency_key = booking id
    // links this entry to the booking for the cancellation punch-return.
    const nextUsed = cardRow.usedEntries + 1;
    const exhausted = nextUsed >= cardRow.totalEntries;
    await tx.insert(punchCardEntries).values({
      punchCardId: cardRow.id,
      punchedBy: null,
      method: 'online',
      entriesConsumed: 1,
      idempotencyKey: booking.id,
      notes: `round booking ${booking.id}`,
      punchedAt: now,
    });
    await tx
      .update(punchCards)
      .set({ usedEntries: nextUsed, isActive: !exhausted, updatedAt: now })
      .where(eq(punchCards.id, cardRow.id));

    // If this customer was on the waitlist for this round, close their offer.
    await markWaitlistClaimed(tx, input.roundInstanceId, input.customerId, now);

    return {
      ok: true as const,
      bookingId: booking.id,
      barcodeToken: token,
      remaining: cardRow.totalEntries - nextUsed,
    };
  });
};
