// Manual arrival marking for round bookings (plan 2026-07-05-staff-manual-arrival).
// The floor often doesn't scan (Yanay): staff mark a booked customer in by tap,
// from the round's attendee list or from the customer's POS screen. This is the
// FIRST check-in path for bookings — the QR exists but has no scanner yet; a
// future door scan will reuse setBookingArrival.

import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { venueTodayIso } from './round-time';
import { bookings, roundInstances, rounds } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type SetBookingArrivalResult =
  | { ok: true; arrived: boolean; usedAt: string | null; changed: boolean }
  | { ok: false; error: 'not_found' | 'not_markable' | 'not_today' };

/**
 * Flip a booking's arrival: confirmed → used (+usedAt) or, for a mistaken tap,
 * used → confirmed (usedAt cleared). Idempotent in both directions. Only for
 * rounds happening on the venue-local TODAY — arrival is a physical fact, not
 * something to pre-fill or backfill. Held/cancelled bookings can't be marked.
 */
export const setBookingArrival = async (
  db: AnyPgDatabase,
  input: { bookingId: string; arrived: boolean },
  now: Date = new Date(),
): Promise<SetBookingArrivalResult> => {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: bookings.id,
        status: bookings.status,
        usedAt: bookings.usedAt,
        date: roundInstances.date,
      })
      .from(bookings)
      .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
      .where(eq(bookings.id, input.bookingId))
      .for('update', { of: bookings });
    const booking = rows[0];
    if (!booking) return { ok: false, error: 'not_found' as const };
    if (booking.status !== 'confirmed' && booking.status !== 'used') {
      return { ok: false, error: 'not_markable' as const };
    }
    if (booking.date !== venueTodayIso(now)) return { ok: false, error: 'not_today' as const };

    const alreadyThere =
      (input.arrived && booking.status === 'used') ||
      (!input.arrived && booking.status === 'confirmed');
    if (alreadyThere) {
      return {
        ok: true as const,
        arrived: input.arrived,
        usedAt: booking.usedAt ? booking.usedAt.toISOString() : null,
        changed: false,
      };
    }

    await tx
      .update(bookings)
      .set(
        input.arrived
          ? { status: 'used', usedAt: now, updatedAt: now }
          : { status: 'confirmed', usedAt: null, updatedAt: now },
      )
      .where(eq(bookings.id, booking.id));
    return {
      ok: true as const,
      arrived: input.arrived,
      usedAt: input.arrived ? now.toISOString() : null,
      changed: true,
    };
  });
};

export interface CustomerDayBooking {
  bookingId: string;
  roundInstanceId: string;
  label: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  arrived: boolean;
  /** ISO timestamp of check-in; null until arrival. */
  usedAt: string | null;
}

/**
 * A customer's bookings on one date — the POS "found them in לקוחות, mark them
 * in" path. Confirmed + used only (held/cancelled are not arrivals-in-waiting).
 */
export const listCustomerRoundBookingsForDate = async (
  db: AnyPgDatabase,
  customerId: string,
  dateIso: string,
): Promise<CustomerDayBooking[]> => {
  const rows = await db
    .select({
      bookingId: bookings.id,
      roundInstanceId: bookings.roundInstanceId,
      label: rounds.displayName,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
      ticketType: bookings.ticketType,
      additionalCompanions: bookings.additionalCompanions,
      source: bookings.source,
      status: bookings.status,
      usedAt: bookings.usedAt,
    })
    .from(bookings)
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(and(eq(bookings.customerId, customerId), eq(roundInstances.date, dateIso)))
    .orderBy(asc(rounds.startTime));
  return rows
    .filter((r) => r.status === 'confirmed' || r.status === 'used')
    .map((r) => ({
      bookingId: r.bookingId,
      roundInstanceId: r.roundInstanceId,
      label: r.label,
      startTime: r.startTime.slice(0, 5),
      endTime: r.endTime.slice(0, 5),
      ticketType: r.ticketType as 'child_under_walking' | 'child_over_walking',
      additionalCompanions: r.additionalCompanions,
      source: r.source as 'paid' | 'punchcard' | 'gift' | 'manual',
      arrived: r.status === 'used',
      usedAt: r.usedAt ? r.usedAt.toISOString() : null,
    }));
};
