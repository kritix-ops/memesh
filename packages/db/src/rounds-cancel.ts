// Cancel a confirmed booking with a refund (super-brief §6.2). Money-safety is
// the whole point: in AUTO mode the seat is released ONLY after the refund is
// confirmed — if it can't be confirmed we don't cancel, so the customer keeps
// their paid seat and can retry. The refund is injected so this stays free of
// the WC client; it runs inside the transaction under the booking's row lock,
// which serializes concurrent cancels (no double refund).
//
// MANUAL mode (input.manualRefund, Yanay 2026-07-13 "בינתיים"): while the
// payment provider has no refund API, the seat is freed WITHOUT calling the
// refund and `refundPending` is returned so the route can email staff to refund
// by hand. This trades the fail-closed money guarantee for a working cancel —
// an explicit, reversible operator choice, off again once auto-refund returns.

import { and, eq, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { logStaffAction } from './actions';
import { getCardSettings } from './card-settings';
import { getRoundSettings } from './round-settings';
import { isWithinCancelWindow } from './round-time';
import {
  bookings,
  customers,
  punchCardEntries,
  punchCards,
  roundInstances,
  rounds,
} from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type CancelBookingInput = {
  bookingId: string;
  /**
   * When set, the booking must belong to this customer or the cancel is
   * refused (`forbidden`). Omit for an admin/staff-initiated removal, which
   * acts on any customer's booking.
   */
  customerId?: string;
  /**
   * Skip the 24h cancellation-window (`too_late`) gate. Admin override only —
   * the customer route never sets this, so customers stay bound to the window.
   */
  skipWindow?: boolean;
  /**
   * Interim manual-refund mode (Yanay 2026-07-13, "בינתיים"): while the payment
   * provider has no refund API, free the seat WITHOUT calling the WooCommerce
   * refund and flag `refundPending` so the caller can email staff to refund by
   * hand. The punch-entry return still happens (it moves no money). Flip off
   * once auto-refund works again.
   */
  manualRefund?: boolean;
  /**
   * The staff member performing a manual-refund cancel, if any. In manual mode a
   * durable `manual_refund_pending` staff-action row is written inside the cancel
   * transaction so the owed refund is queryable (not just a warn log); this
   * stamps who initiated it. Omitted for a customer-initiated cancel (staffId
   * null).
   */
  refundActorStaffId?: string;
};

export type CancelBookingDeps = {
  /**
   * Refund `amountIls` against `wcOrderId`. Must return true ONLY when the
   * refund is confirmed. Injected so the DB layer never imports the WC client.
   */
  refund: (wcOrderId: string, amountIls: number) => Promise<boolean>;
};

export type CancelBookingResult =
  | {
      ok: true;
      /** True when a WooCommerce refund was confirmed (auto mode). */
      refunded: boolean;
      /** True when the seat was freed but the money refund is left for staff to
       *  do by hand (manual mode). Mutually exclusive with `refunded`. */
      refundPending: boolean;
      punchReturned: boolean;
      refundAmountIls: number;
      roundInstanceId: string;
      /** The WC order to refund (for the manual-refund staff alert). */
      wcOrderId: string | null;
      source: 'paid' | 'punchcard' | 'gift' | 'manual';
    }
  | { ok: false; error: 'not_found' | 'forbidden' | 'not_confirmed' | 'too_late' | 'refund_failed' };

const hhmm = (t: string): string => t.slice(0, 5);

export interface BookingNotifyDetails {
  customer: { firstName: string; lastName: string; phone: string; email: string | null };
  /** Round display name. */
  label: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  startTime: string;
  endTime: string;
  bookingNumber: string | null;
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  wcOrderId: string | null;
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
}

/**
 * Customer + round + booking display fields for the cancellation notification
 * emails (manual-refund staff alert + customer confirmation). Read after the
 * cancel — the booking row survives as `cancelled`. Null if the id is unknown.
 */
export const getBookingNotifyDetails = async (
  db: AnyPgDatabase,
  bookingId: string,
): Promise<BookingNotifyDetails | null> => {
  const rows = await db
    .select({
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      email: customers.email,
      label: rounds.displayName,
      date: roundInstances.date,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
      bookingNumber: bookings.bookingNumber,
      source: bookings.source,
      wcOrderId: bookings.wcOrderId,
      ticketType: bookings.ticketType,
      additionalCompanions: bookings.additionalCompanions,
    })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    customer: { firstName: r.firstName, lastName: r.lastName, phone: r.phone, email: r.email },
    label: r.label,
    date: r.date,
    startTime: hhmm(r.startTime),
    endTime: hhmm(r.endTime),
    bookingNumber: r.bookingNumber,
    source: r.source as BookingNotifyDetails['source'],
    wcOrderId: r.wcOrderId,
    ticketType: r.ticketType as BookingNotifyDetails['ticketType'],
    additionalCompanions: r.additionalCompanions,
  };
};

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
        roundInstanceId: bookings.roundInstanceId,
        status: bookings.status,
        source: bookings.source,
        wcOrderId: bookings.wcOrderId,
        ticketType: bookings.ticketType,
        additionalCompanions: bookings.additionalCompanions,
        paidTicketIls: bookings.paidTicketIls,
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
    // Ownership is enforced only for customer-initiated cancels; an admin/staff
    // removal passes no customerId and may act on any booking.
    if (input.customerId !== undefined && b.customerId !== input.customerId) {
      return { ok: false, error: 'forbidden' as const };
    }
    if (b.status !== 'confirmed') return { ok: false, error: 'not_confirmed' as const };

    // The cancellation window binds customers; an admin override skips it so a
    // last-minute no-show / mistake can be removed. Money-safety is unchanged —
    // a paid booking still refunds fail-closed below regardless of the window.
    if (!input.skipWindow) {
      const roundSettings = await getRoundSettings(tx);
      if (!isWithinCancelWindow(b.date, hhmm(b.startTime), roundSettings.cancellationWindowHours, now)) {
        return { ok: false, error: 'too_late' as const };
      }
    }

    let refunded = false;
    let refundPending = false;
    let punchReturned = false;
    let refundAmountIls = 0;

    if (b.source === 'paid') {
      // Refund value = ticket price + companions × companion price. The ticket
      // price comes from what WooCommerce actually charged (snapshotted at mint,
      // `paidTicketIls`) so a later price-setting change can't skew the refund;
      // it falls back to the settings price for bookings minted before that
      // snapshot existed. The companion add-on stays settings-derived.
      const cardSettings = await getCardSettings(tx);
      const ticketPrice =
        b.paidTicketIls ??
        (b.ticketType === 'child_under_walking'
          ? cardSettings.roundChildBabyPriceIls
          : cardSettings.roundChildOverWalkingPriceIls);
      refundAmountIls = ticketPrice + b.additionalCompanions * cardSettings.roundAdditionalCompanionPriceIls;
      if (input.manualRefund) {
        // Interim: release the seat now; the money refund is handed to staff.
        refundPending = true;
      } else {
        // Auto mode: a paid booking must have a confirmed refund before the
        // seat is released (fail closed — no seat freed without money back).
        if (!b.wcOrderId) return { ok: false, error: 'refund_failed' as const };
        refunded = await deps.refund(b.wcOrderId, refundAmountIls);
        if (!refunded) return { ok: false, error: 'refund_failed' as const };
      }
    } else if (b.source === 'punchcard') {
      // A paid extra companion rides on the punch booking (wc_order_id +
      // additional_companions > 0). Its money must come back before the seat
      // is released — same fail-closed rule as paid bookings. An unpaid
      // pending companion order (additional_companions still 0) refunds
      // nothing; the order just dies unpaid in WC.
      if (b.additionalCompanions > 0 && b.wcOrderId) {
        const cardSettings = await getCardSettings(tx);
        refundAmountIls = b.additionalCompanions * cardSettings.roundAdditionalCompanionPriceIls;
        // A zero amount means the companion was free (price setting 0) — no
        // money moved, nothing to refund.
        if (refundAmountIls > 0) {
          if (input.manualRefund) {
            refundPending = true;
          } else {
            refunded = await deps.refund(b.wcOrderId, refundAmountIls);
            if (!refunded) return { ok: false, error: 'refund_failed' as const };
          }
        }
      }
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
          // Atomically flip the entry to refunded. The `refunded_at IS NULL`
          // guard is what prevents a concurrent staff refundEntry on the same
          // entry from crediting the punch back twice (TOCTOU): the
          // `entry.refundedAt === null` read above is only a fast-path. If the
          // entry was already refunded, this matches 0 rows and the card is
          // left untouched.
          const flipped = await tx
            .update(punchCardEntries)
            .set({ refundedAt: now, refundReason: 'round booking cancelled' })
            .where(and(eq(punchCardEntries.id, entry.id), isNull(punchCardEntries.refundedAt)))
            .returning({ id: punchCardEntries.id });
          if (flipped.length > 0) {
            const restored = Math.max(0, card.usedEntries - entry.entriesConsumed);
            const reactivate = !card.isActive && card.cancelledAt === null;
            await tx
              .update(punchCards)
              .set({ usedEntries: restored, ...(reactivate && { isActive: true }), updatedAt: now })
              .where(eq(punchCards.id, card.id));
            punchReturned = true;
          }
        }
      }
    }
    // (gift/manual sources don't exist in the v1 flow; gift refund lands with §7.)

    await tx.update(bookings).set({ status: 'cancelled', updatedAt: now }).where(eq(bookings.id, b.id));

    // Manual-refund mode frees the seat but hands the money back to staff by
    // hand. Persist a durable, queryable record of the owed refund INSIDE this
    // transaction so the obligation survives even when no cancellation-alert
    // email is configured (otherwise it existed only as a scroll-away warn log).
    if (refundPending && refundAmountIls > 0) {
      await logStaffAction(tx, {
        action: 'manual_refund_pending',
        summary: `החזר ידני נדרש · ₪${refundAmountIls} · הזמנת WooCommerce ${b.wcOrderId ?? '—'}`,
        ...(input.refundActorStaffId !== undefined && { staffId: input.refundActorStaffId }),
        now,
      });
    }
    // The route promotes the waitlist for this freed seat after the tx commits.
    return {
      ok: true as const,
      refunded,
      refundPending,
      punchReturned,
      refundAmountIls,
      roundInstanceId: b.roundInstanceId,
      wcOrderId: b.wcOrderId,
      source: b.source as 'paid' | 'punchcard' | 'gift' | 'manual',
    };
  });
};
