// Staff/admin walk-in add (Yanay 2026-07-07): put a child on a round from the
// floor even when it's full. A walk-in is a `source='manual'` booking — that's
// the marker that keeps it visibly separate from the ones who registered
// online. Capacity is deliberately NOT a hard gate: a full round can still take
// a walk-in when `allowOverCapacity` is set, and the result reports whether the
// add pushed past capacity so the UI can badge it. Confirmed immediately (the
// child is physically here) with its own barcode + booking number, and every
// add writes a staff-action audit row.

import { and, count as countRows, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { signBookingToken, type KeyResolver } from '@memesh/qr-engine';
import { logStaffAction } from './actions';
import { allocateBookingNumber } from './cards';
import { bookings, customers, roundInstances, rounds } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type AddWalkInInput = {
  roundInstanceId: string;
  /** The customer the walk-in belongs to — so it shows in their history and at
   *  the door (no anonymous bookings). */
  customerId: string;
  ticketType?: 'child_under_walking' | 'child_over_walking';
  /** Staff member performing the add, for the audit row. */
  staffId?: string;
  /** When false, a full round refuses the add (`round_full`); when true, the
   *  add goes through over capacity and `overCapacity` reports it. */
  allowOverCapacity: boolean;
};

export type AddWalkInResult =
  | {
      ok: true;
      bookingId: string;
      barcodeToken: string;
      bookingNumber: string;
      /** True when this add pushed the round past its capacity. */
      overCapacity: boolean;
      taken: number;
      capacity: number;
    }
  | { ok: false; error: 'round_not_found' | 'round_closed' | 'customer_not_found' | 'round_full' };

export const addWalkInBooking = async (
  db: AnyPgDatabase,
  input: AddWalkInInput,
  resolver: KeyResolver,
  now: Date = new Date(),
): Promise<AddWalkInResult> => {
  const ticketType = input.ticketType ?? 'child_over_walking';
  return db.transaction(async (tx) => {
    // Lock the instance + its round (for the audit label) and recount taken —
    // the same live-occupancy definition the booking paths use.
    const instRows = await tx
      .select({
        id: roundInstances.id,
        capacity: roundInstances.capacity,
        isClosed: roundInstances.isClosed,
        date: roundInstances.date,
        label: rounds.displayName,
        startTime: rounds.startTime,
      })
      .from(roundInstances)
      .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
      .where(eq(roundInstances.id, input.roundInstanceId))
      .for('update', { of: roundInstances });
    const inst = instRows[0];
    if (!inst) return { ok: false, error: 'round_not_found' as const };
    // A closed instance is an admin decision (private event / holiday); a
    // walk-in doesn't override that, unlike a merely-full round.
    if (inst.isClosed) return { ok: false, error: 'round_closed' as const };

    const custRows = await tx
      .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    const cust = custRows[0];
    if (!cust) return { ok: false, error: 'customer_not_found' as const };

    const takenRows = await tx
      .select({ n: countRows() })
      .from(bookings)
      .where(
        and(
          eq(bookings.roundInstanceId, input.roundInstanceId),
          sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
        ),
      );
    const taken = Number(takenRows[0]?.n ?? 0);
    const overCapacity = taken + 1 > inst.capacity;
    if (overCapacity && !input.allowOverCapacity) {
      return { ok: false, error: 'round_full' as const };
    }

    const bookingNumber = await allocateBookingNumber(tx, now);
    const inserted = await tx
      .insert(bookings)
      .values({
        roundInstanceId: input.roundInstanceId,
        customerId: cust.id,
        ticketType,
        additionalCompanions: 0,
        source: 'manual' as const,
        status: 'confirmed' as const,
        bookingNumber,
        confirmedAt: now,
        updatedAt: now,
      })
      .returning({ id: bookings.id, barcodeVersion: bookings.barcodeVersion });
    const booking = inserted[0];
    if (!booking) throw new Error('[rounds-walkin] booking insert returned no row');

    const token = signBookingToken({ bookingId: booking.id, version: booking.barcodeVersion }, resolver);
    await tx.update(bookings).set({ barcodeToken: token }).where(eq(bookings.id, booking.id));

    await logStaffAction(tx, {
      action: 'other',
      summary: `הוספה ידנית לסבב · ${cust.firstName} ${cust.lastName} · ${inst.label} ${inst.date} ${inst.startTime.slice(0, 5)}${overCapacity ? ' · מעל התפוסה' : ''}`,
      ...(input.staffId ? { staffId: input.staffId } : {}),
      now,
    });

    return {
      ok: true as const,
      bookingId: booking.id,
      barcodeToken: token,
      bookingNumber,
      overCapacity,
      taken: taken + 1,
      capacity: inst.capacity,
    };
  });
};
