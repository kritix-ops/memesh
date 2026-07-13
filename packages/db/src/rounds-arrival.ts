// Manual arrival marking for round bookings (plan 2026-07-05-staff-manual-arrival).
// The floor often doesn't scan (Yanay): staff mark a booked customer in by tap,
// from the round's attendee list or from the customer's POS screen. This is the
// FIRST check-in path for bookings — the QR exists but has no scanner yet; a
// future door scan will reuse setBookingArrival.

import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getRoundSettings } from './round-settings';
import { isMarkingClosed, venueTodayIso } from './round-time';
import { bookings, customers, roundInstances, rounds } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type SetBookingArrivalResult =
  | { ok: true; arrived: boolean; usedAt: string | null; changed: boolean }
  | { ok: false; error: 'not_found' | 'not_markable' | 'not_today' | 'round_ended' };

/**
 * Flip a booking's arrival: confirmed → used (+usedAt) or, for a mistaken tap,
 * used → confirmed (usedAt cleared). Idempotent in both directions. Only for
 * rounds happening on the venue-local TODAY, and only while the round is still
 * running — once its end time (plus the configured grace) has passed the round
 * is closed for marking (Yanay 2026-07-13: "once the round is over, staff can't
 * mark anything").
 * Arrival is a physical fact, not something to pre-fill or backfill.
 * Held/cancelled bookings can't be marked.
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
        endTime: rounds.endTime,
      })
      .from(bookings)
      .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
      .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
      .where(eq(bookings.id, input.bookingId))
      .for('update', { of: bookings });
    const booking = rows[0];
    if (!booking) return { ok: false, error: 'not_found' as const };
    if (booking.status !== 'confirmed' && booking.status !== 'used') {
      return { ok: false, error: 'not_markable' as const };
    }
    if (booking.date !== venueTodayIso(now)) return { ok: false, error: 'not_today' as const };
    // Once a round is over — plus the configured grace — it's closed for
    // marking. The grace keeps the floor from being cut off mid-tap for a late
    // arrival; markingGraceMinutes = 0 makes it a hard lock at end time.
    const settings = await getRoundSettings(tx);
    if (isMarkingClosed(booking.date, booking.endTime.slice(0, 5), settings.markingGraceMinutes, now)) {
      return { ok: false, error: 'round_ended' as const };
    }

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

export interface CheckinBooking {
  bookingId: string;
  bookingNumber: string | null;
  customer: { firstName: string; lastName: string; phone: string };
  label: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  /** YYYY-MM-DD */
  date: string;
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  status: 'held' | 'confirmed' | 'used' | 'cancelled' | 'expired';
  arrived: boolean;
  usedAt: string | null;
}

export type CheckinLookupResult =
  | { ok: true; booking: CheckinBooking }
  | { ok: false; error: 'not_found' | 'stale_qr' };

/**
 * Resolve a booking for the door check-in screen — by verified QR payload
 * (id + signed barcode version) or by the human-typed booking number. A
 * version mismatch means the QR predates a swap re-mint: 'stale_qr', so a
 * screenshotted old barcode can't check in against the new slot.
 */
export const lookupBookingForCheckin = async (
  db: AnyPgDatabase,
  query: { bookingId: string; version: number } | { bookingNumber: string },
): Promise<CheckinLookupResult> => {
  const where =
    'bookingId' in query
      ? eq(bookings.id, query.bookingId)
      : eq(bookings.bookingNumber, query.bookingNumber.trim().toUpperCase());
  const rows = await db
    .select({
      bookingId: bookings.id,
      bookingNumber: bookings.bookingNumber,
      barcodeVersion: bookings.barcodeVersion,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      label: rounds.displayName,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
      date: roundInstances.date,
      ticketType: bookings.ticketType,
      additionalCompanions: bookings.additionalCompanions,
      source: bookings.source,
      status: bookings.status,
      usedAt: bookings.usedAt,
    })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(where)
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, error: 'not_found' as const };
  if ('version' in query && row.barcodeVersion !== query.version) {
    return { ok: false, error: 'stale_qr' as const };
  }
  return {
    ok: true as const,
    booking: {
      bookingId: row.bookingId,
      bookingNumber: row.bookingNumber,
      customer: { firstName: row.firstName, lastName: row.lastName, phone: row.phone },
      label: row.label,
      startTime: row.startTime.slice(0, 5),
      endTime: row.endTime.slice(0, 5),
      date: row.date,
      ticketType: row.ticketType as CheckinBooking['ticketType'],
      additionalCompanions: row.additionalCompanions,
      source: row.source as CheckinBooking['source'],
      status: row.status as CheckinBooking['status'],
      arrived: row.status === 'used',
      usedAt: row.usedAt ? row.usedAt.toISOString() : null,
    },
  };
};

export interface CustomerDayBooking {
  bookingId: string;
  bookingNumber: string | null;
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
      bookingNumber: bookings.bookingNumber,
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
      bookingNumber: r.bookingNumber,
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
