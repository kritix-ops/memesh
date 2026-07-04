// Book round seats by spending punch-card entries (super-brief §3.4). Same
// oversell guard as the paid hold, but instead of a WooCommerce payment the
// bookings are confirmed immediately against entries on the customer's OWN
// card — `count` entries mint `count` bookings (one child + one companion
// each). It all runs in one transaction — reserve the seats, mint the
// barcodes, punch the card — so there is never a spent punch without a
// booking, or a booking without a spent punch. The door same-day lockout in punchCard() is a
// door concept and would wrongly block advance bookings, so the punch is
// written inline here (method 'online', punched_by null, no lockout). The
// entry's idempotency_key is the booking id, which is the link cancellation
// uses to find and reverse this exact punch.

import { and, count as countRows, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { signBookingToken, type KeyResolver } from '@memesh/qr-engine';
import { getRoundSettings } from './round-settings';
import { isInstanceSchedulable } from './rounds-schedule';
import { markWaitlistClaimed } from './rounds-waitlist';
import { bookings, punchCardEntries, punchCards, roundInstances } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type BookRoundWithPunchInput = {
  roundInstanceId: string;
  customerId: string;
  punchCardId: string;
  ticketType: 'child_under_walking' | 'child_over_walking';
  /** Entries to spend in one go — N punches mint N bookings. Defaults to 1. */
  count?: number;
};

export type BookedPunchEntry = { bookingId: string; barcodeToken: string };

export type BookRoundWithPunchResult =
  | { ok: true; bookings: BookedPunchEntry[]; remaining: number }
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
        | 'card_exhausted'
        | 'not_enough_entries';
    };

export const bookRoundWithPunch = async (
  db: AnyPgDatabase,
  input: BookRoundWithPunchInput,
  resolver: KeyResolver,
  now: Date = new Date(),
): Promise<BookRoundWithPunchResult> => {
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`[rounds-punch] invalid count ${count}`);
  }

  // Schedule guards — same rule as createHold: master switch off or a round
  // filtered out by the date's schedule rule is not bookable, punch included.
  const settings = await getRoundSettings(db);
  if (!settings.roundsEnabled) return { ok: false, error: 'round_closed' as const };
  const schedulable = await isInstanceSchedulable(db, input.roundInstanceId);
  if (!schedulable.ok) {
    return {
      ok: false,
      error: schedulable.reason === 'not_found' ? ('round_not_found' as const) : ('round_closed' as const),
    };
  }

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
      .select({ n: countRows() })
      .from(bookings)
      .where(
        and(
          eq(bookings.roundInstanceId, input.roundInstanceId),
          sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
        ),
      );
    if (Number(takenRows[0]?.n ?? 0) + count > inst.capacity) {
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
    if (cardRow.usedEntries + count > cardRow.totalEntries) {
      return { ok: false, error: 'not_enough_entries' as const };
    }

    // 3. Insert the confirmed bookings, then sign each barcode (needs the id).
    // One row per entry — a punch booking is always one child + one companion,
    // so N punches are N bookings, never one booking with a quantity.
    const insertedBookings = await tx
      .insert(bookings)
      .values(
        Array.from({ length: count }, () => ({
          roundInstanceId: input.roundInstanceId,
          customerId: input.customerId,
          ticketType: input.ticketType,
          additionalCompanions: 0,
          source: 'punchcard' as const,
          status: 'confirmed' as const,
          punchCardId: cardRow.id,
          confirmedAt: now,
          updatedAt: now,
        })),
      )
      .returning({ id: bookings.id, barcodeVersion: bookings.barcodeVersion });
    if (insertedBookings.length !== count) {
      throw new Error('[rounds-punch] booking insert returned wrong row count');
    }

    const booked: BookedPunchEntry[] = [];
    for (const booking of insertedBookings) {
      const token = signBookingToken({ bookingId: booking.id, version: booking.barcodeVersion }, resolver);
      await tx.update(bookings).set({ barcodeToken: token }).where(eq(bookings.id, booking.id));
      booked.push({ bookingId: booking.id, barcodeToken: token });
    }

    // 4. Punch the card inline (no door lockout), one entry per booking so
    // idempotency_key = booking id still lets cancellation reverse exactly the
    // punch that paid for the cancelled booking.
    await tx.insert(punchCardEntries).values(
      booked.map((b) => ({
        punchCardId: cardRow.id,
        punchedBy: null,
        method: 'online' as const,
        entriesConsumed: 1,
        idempotencyKey: b.bookingId,
        notes: `round booking ${b.bookingId}`,
        punchedAt: now,
      })),
    );
    const nextUsed = cardRow.usedEntries + count;
    const exhausted = nextUsed >= cardRow.totalEntries;
    await tx
      .update(punchCards)
      .set({ usedEntries: nextUsed, isActive: !exhausted, updatedAt: now })
      .where(eq(punchCards.id, cardRow.id));

    // If this customer was on the waitlist for this round, close their offer.
    await markWaitlistClaimed(tx, input.roundInstanceId, input.customerId, now);

    return {
      ok: true as const,
      bookings: booked,
      remaining: cardRow.totalEntries - nextUsed,
    };
  });
};
