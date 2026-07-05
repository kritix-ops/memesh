// The hold engine (super-brief §3) — the race-safe core of the purchase flow.
// A hold reserves one child seat before payment; expiry returns it to the pool.
// createHold is the oversell guard: a row lock serializes the check-and-insert
// so two buyers can't take the last seat.

import { and, count, eq, lte, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { allocateBookingNumber } from './cards';
import { getRoundSettings } from './round-settings';
import { isInstanceSchedulable } from './rounds-schedule';
import { bookings, roundInstances } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type HoldTicketType = 'child_under_walking' | 'child_over_walking';
export type HoldSource = 'paid' | 'punchcard' | 'gift' | 'manual';

export type CreateHoldInput = {
  roundInstanceId: string;
  customerId: string;
  ticketType: HoldTicketType;
  additionalCompanions?: number;
  /** Provisional — the confirm/mint step sets the real source. Defaults to 'paid'. */
  source?: HoldSource;
  /**
   * Refresh an existing active hold for the same customer + instance + ticket
   * type instead of inserting a second row. Set by the WC checkout path only:
   * WooCommerce re-creates order line items on every checkout attempt, so a
   * payment retry re-fires the hold hook and would otherwise pin a ghost seat
   * for the TTL (Yanay's "2/60" report, 2026-07-04). Safe there because the WP
   * cart allows at most one line per ticket product. Customer-app callers
   * leave it unset.
   */
  reuseActiveHold?: boolean;
};

export type CreateHoldResult =
  | { ok: true; holdId: string; expiresAt: string; reused: boolean }
  | { ok: false; error: 'not_found' | 'closed' | 'sold_out' };

/**
 * Reserve one child seat race-safely (super-brief §3.2). In a transaction:
 * lock the round_instance FOR UPDATE, recount taken (confirmed + used + active
 * holds; companions never count), and insert a `held` booking only if there is
 * room. The row lock serializes the check-and-insert so two buyers can't grab
 * the last seat. hold_expires_at = now + hold_ttl_minutes (round_settings).
 *
 * NOTE: the concurrency guarantee can only be proven against real Postgres with
 * parallel connections. The PGlite fixture is single-connection, so its tests
 * verify the capacity logic, not the race — see the concurrency test note in
 * rounds-hold.test.ts.
 */
export const createHold = async (
  db: AnyPgDatabase,
  input: CreateHoldInput,
  now: Date = new Date(),
): Promise<CreateHoldResult> => {
  const settings = await getRoundSettings(db);
  const ttlMs = settings.holdTtlMinutes * 60_000;

  // Schedule guards (plan 2026-07-02-round-schedule-rules): with the master
  // switch off, or the round filtered out by the date's schedule rule, this
  // seat is not purchasable — even via a direct API call the pickers would
  // never make. 'closed' matches what the callers already map to 409.
  if (!settings.roundsEnabled) return { ok: false, error: 'closed' as const };
  const schedulable = await isInstanceSchedulable(db, input.roundInstanceId);
  if (!schedulable.ok) {
    return { ok: false, error: schedulable.reason === 'not_found' ? ('not_found' as const) : ('closed' as const) };
  }

  return db.transaction(async (tx) => {
    const locked = await tx
      .select({
        id: roundInstances.id,
        capacity: roundInstances.capacity,
        isClosed: roundInstances.isClosed,
      })
      .from(roundInstances)
      .where(eq(roundInstances.id, input.roundInstanceId))
      .for('update');
    const inst = locked[0];
    if (!inst) return { ok: false, error: 'not_found' as const };
    if (inst.isClosed) return { ok: false, error: 'closed' as const };

    // Reuse before the capacity check: the existing hold already occupies its
    // seat, so refreshing it must succeed even on a round that filled up
    // between the two checkout attempts.
    if (input.reuseActiveHold) {
      const existing = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.roundInstanceId, input.roundInstanceId),
            eq(bookings.customerId, input.customerId),
            eq(bookings.ticketType, input.ticketType),
            eq(bookings.status, 'held'),
            sql`${bookings.holdExpiresAt} > ${now}`,
          ),
        )
        .limit(1)
        .for('update');
      const hold = existing[0];
      if (hold) {
        const holdExpiresAt = new Date(now.getTime() + ttlMs);
        await tx
          .update(bookings)
          .set({
            holdExpiresAt,
            // Last submission wins — the retry may have toggled the companion
            // checkbox, and this is what the customer is about to pay for.
            additionalCompanions: input.additionalCompanions ?? 0,
            updatedAt: now,
          })
          .where(eq(bookings.id, hold.id));
        return { ok: true as const, holdId: hold.id, expiresAt: holdExpiresAt.toISOString(), reused: true };
      }
    }

    const takenRows = await tx
      .select({ n: count() })
      .from(bookings)
      .where(
        and(
          eq(bookings.roundInstanceId, input.roundInstanceId),
          sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
        ),
      );
    const taken = Number(takenRows[0]?.n ?? 0);
    if (taken + 1 > inst.capacity) return { ok: false, error: 'sold_out' as const };

    const holdExpiresAt = new Date(now.getTime() + ttlMs);
    const inserted = await tx
      .insert(bookings)
      .values({
        roundInstanceId: input.roundInstanceId,
        customerId: input.customerId,
        ticketType: input.ticketType,
        additionalCompanions: input.additionalCompanions ?? 0,
        source: input.source ?? 'paid',
        status: 'held',
        // The ticket's manual door fallback, assigned at birth so it never
        // changes across hold → confirmed → used.
        bookingNumber: await allocateBookingNumber(tx, now),
        holdExpiresAt,
      })
      .returning({ id: bookings.id });
    const booking = inserted[0];
    if (!booking) throw new Error('[rounds-hold] insert returned no row');
    return { ok: true as const, holdId: booking.id, expiresAt: holdExpiresAt.toISOString(), reused: false };
  });
};

export type ReleaseHoldResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'forbidden' | 'not_held' };

/**
 * Release a held seat early. Owner-gated: only the customer who created the
 * hold may release it. Frees the seat immediately (status → expired).
 */
export const releaseHold = async (
  db: AnyPgDatabase,
  holdId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<ReleaseHoldResult> => {
  const rows = await db
    .select({ id: bookings.id, customerId: bookings.customerId, status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, holdId))
    .limit(1);
  const b = rows[0];
  if (!b) return { ok: false, error: 'not_found' as const };
  if (b.customerId !== customerId) return { ok: false, error: 'forbidden' as const };
  if (b.status !== 'held') return { ok: false, error: 'not_held' as const };
  await db.update(bookings).set({ status: 'expired', updatedAt: now }).where(eq(bookings.id, holdId));
  return { ok: true as const };
};

export interface ExpiredHold {
  id: string;
  roundInstanceId: string;
}

/**
 * Sweep expired holds (super-brief §3.3): flip `held` bookings whose
 * hold_expires_at has passed to `expired`. Returns the freed bookings so the
 * caller can trigger waitlist promotion (later PR). Idempotent — a second run
 * finds nothing.
 */
export const expireHolds = async (db: AnyPgDatabase, now: Date = new Date()): Promise<ExpiredHold[]> => {
  return db
    .update(bookings)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(bookings.status, 'held'), lte(bookings.holdExpiresAt, now)))
    .returning({ id: bookings.id, roundInstanceId: bookings.roundInstanceId });
};
