// Swap a confirmed booking to another round instance (super-brief §6.1). Atomic:
// both the timing gate and the target-availability check happen under row locks,
// so a swap can't oversell the target and can't slip past the original round's
// start. Re-mints the barcode at a bumped version, invalidating any old QR the
// customer screenshotted for the previous time.

import { and, count, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { signBookingToken, type KeyResolver } from '@memesh/qr-engine';
import { isBeforeRoundStart } from './round-time';
import { bookings, roundInstances, rounds } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type SwapBookingInput = {
  bookingId: string;
  customerId: string;
  targetRoundInstanceId: string;
};

export type SwapBookingResult =
  | { ok: true; bookingId: string; barcodeToken: string; barcodeVersion: number }
  | {
      ok: false;
      error:
        | 'not_found'
        | 'forbidden'
        | 'not_confirmed'
        | 'too_late'
        | 'same_round'
        | 'target_not_found'
        | 'target_closed'
        | 'target_full';
    };

const hhmm = (t: string): string => t.slice(0, 5);

export const swapBooking = async (
  db: AnyPgDatabase,
  input: SwapBookingInput,
  resolver: KeyResolver,
  now: Date = new Date(),
): Promise<SwapBookingResult> => {
  return db.transaction(async (tx) => {
    // Load + lock the booking; join its current round for the timing gate.
    const rows = await tx
      .select({
        id: bookings.id,
        customerId: bookings.customerId,
        status: bookings.status,
        roundInstanceId: bookings.roundInstanceId,
        barcodeVersion: bookings.barcodeVersion,
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
    if (b.roundInstanceId === input.targetRoundInstanceId) {
      return { ok: false, error: 'same_round' as const };
    }
    // Allowed only until the ORIGINAL round starts (super-brief §6.1).
    if (!isBeforeRoundStart(b.date, hhmm(b.startTime), now)) {
      return { ok: false, error: 'too_late' as const };
    }

    // Lock the target instance + check room (child-only, active holds included).
    const targetRows = await tx
      .select({ capacity: roundInstances.capacity, isClosed: roundInstances.isClosed })
      .from(roundInstances)
      .where(eq(roundInstances.id, input.targetRoundInstanceId))
      .for('update');
    const target = targetRows[0];
    if (!target) return { ok: false, error: 'target_not_found' as const };
    if (target.isClosed) return { ok: false, error: 'target_closed' as const };
    const takenRows = await tx
      .select({ n: count() })
      .from(bookings)
      .where(
        and(
          eq(bookings.roundInstanceId, input.targetRoundInstanceId),
          sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
        ),
      );
    if (Number(takenRows[0]?.n ?? 0) + 1 > target.capacity) {
      return { ok: false, error: 'target_full' as const };
    }

    // Move + re-mint at a bumped version so the pre-swap QR fails at the door.
    const nextVersion = b.barcodeVersion + 1;
    const token = signBookingToken({ bookingId: b.id, version: nextVersion }, resolver);
    await tx
      .update(bookings)
      .set({
        roundInstanceId: input.targetRoundInstanceId,
        barcodeVersion: nextVersion,
        barcodeToken: token,
        updatedAt: now,
      })
      .where(eq(bookings.id, b.id));

    // Waitlist promotion on the vacated instance lands with the waitlist PR.
    return { ok: true as const, bookingId: b.id, barcodeToken: token, barcodeVersion: nextVersion };
  });
};
