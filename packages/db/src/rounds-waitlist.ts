// Waitlist engine (super-brief §8). When a round is full a customer joins a FIFO
// list; when a seat frees (cancel, swap-out, hold expiry) the next in line is
// offered it with a claim window. The offer is a head start via the normal hold
// flow — the spec does not lock the seat for the claim window — so a timeout
// sweep moves the offer to the next person if it lapses. Notifications live at
// the route/cron layer (this engine returns who to notify); quiet hours defer
// the offer to the next active-hours sweep.

import { and, asc, count, eq, gte, lte, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getRoundSettings } from './round-settings';
import { isWithinActiveHours } from './round-time';
import { bookings, customers, roundInstances, rounds, waitlistEntries } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;
type TicketType = 'child_under_walking' | 'child_over_walking';

const ACTIVE = sql`status IN ('waiting','notified')`;

/** Seats taken in a round: confirmed + used + still-valid holds (companions never count). */
const countTaken = async (tx: AnyPgDatabase, roundInstanceId: string, now: Date): Promise<number> => {
  const rows = await tx
    .select({ n: count() })
    .from(bookings)
    .where(
      and(
        eq(bookings.roundInstanceId, roundInstanceId),
        sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
};

/** 1-based FIFO position among `waiting` entries (by created_at). */
const positionOf = async (tx: AnyPgDatabase, roundInstanceId: string, createdAt: Date): Promise<number> => {
  const rows = await tx
    .select({ n: count() })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.roundInstanceId, roundInstanceId),
        eq(waitlistEntries.status, 'waiting'),
        lte(waitlistEntries.createdAt, createdAt),
      ),
    );
  return Number(rows[0]?.n ?? 0);
};

export type JoinWaitlistInput = {
  roundInstanceId: string;
  customerId: string;
  requestedType: TicketType;
  requestedCompanions?: number;
};

export type JoinWaitlistResult =
  | { ok: true; entryId: string; position: number; alreadyOnList: boolean }
  | { ok: false; error: 'round_not_found' | 'has_availability' };

/**
 * Join the waitlist for a full round. Refuses if the round still has room (the
 * customer should just book). Idempotent — a customer already on the list gets
 * their existing entry back, not a duplicate.
 */
export const joinWaitlist = async (
  db: AnyPgDatabase,
  input: JoinWaitlistInput,
  now: Date = new Date(),
): Promise<JoinWaitlistResult> => {
  return db.transaction(async (tx) => {
    const instRows = await tx
      .select({ id: roundInstances.id, capacity: roundInstances.capacity, isClosed: roundInstances.isClosed })
      .from(roundInstances)
      .where(eq(roundInstances.id, input.roundInstanceId))
      .for('update');
    const inst = instRows[0];
    if (!inst) return { ok: false, error: 'round_not_found' as const };
    // Open round with room → book, don't wait. A closed round can still be
    // waitlisted (it may reopen or a seat may free).
    if (!inst.isClosed) {
      const taken = await countTaken(tx, input.roundInstanceId, now);
      if (taken + 1 <= inst.capacity) return { ok: false, error: 'has_availability' as const };
    }

    const existingRows = await tx
      .select({ id: waitlistEntries.id, createdAt: waitlistEntries.createdAt })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.roundInstanceId, input.roundInstanceId),
          eq(waitlistEntries.customerId, input.customerId),
          ACTIVE,
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      const position = await positionOf(tx, input.roundInstanceId, existing.createdAt);
      return { ok: true as const, entryId: existing.id, position, alreadyOnList: true };
    }

    const inserted = await tx
      .insert(waitlistEntries)
      .values({
        roundInstanceId: input.roundInstanceId,
        customerId: input.customerId,
        requestedType: input.requestedType,
        requestedCompanions: input.requestedCompanions ?? 0,
        status: 'waiting',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: waitlistEntries.id, createdAt: waitlistEntries.createdAt });
    const entry = inserted[0];
    if (!entry) throw new Error('[waitlist] insert returned no row');
    const position = await positionOf(tx, input.roundInstanceId, entry.createdAt);
    return { ok: true as const, entryId: entry.id, position, alreadyOnList: false };
  });
};

export type LeaveWaitlistResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'forbidden' | 'not_active' };

/** Leave the waitlist. Owner-gated; only a waiting/notified entry can be dropped. */
export const leaveWaitlist = async (
  db: AnyPgDatabase,
  entryId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<LeaveWaitlistResult> => {
  const rows = await db
    .select({ id: waitlistEntries.id, customerId: waitlistEntries.customerId, status: waitlistEntries.status })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, entryId))
    .limit(1);
  const e = rows[0];
  if (!e) return { ok: false, error: 'not_found' as const };
  if (e.customerId !== customerId) return { ok: false, error: 'forbidden' as const };
  if (e.status !== 'waiting' && e.status !== 'notified') return { ok: false, error: 'not_active' as const };
  await db.update(waitlistEntries).set({ status: 'cancelled', updatedAt: now }).where(eq(waitlistEntries.id, entryId));
  return { ok: true as const };
};

export interface CustomerWaitlistEntry {
  entryId: string;
  roundInstanceId: string;
  label: string;
  date: string;
  startTime: string;
  endTime: string;
  status: 'waiting' | 'notified';
  requestedType: TicketType;
  /** Set only when notified — the moment the offer lapses. */
  claimExpiresAt: string | null;
}

/** A customer's active waitlist entries (waiting/notified) on today or later. */
export const listCustomerWaitlist = async (
  db: AnyPgDatabase,
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerWaitlistEntry[]> => {
  const todayIso = now.toISOString().slice(0, 10);
  const rows = await db
    .select({
      entryId: waitlistEntries.id,
      roundInstanceId: waitlistEntries.roundInstanceId,
      label: rounds.displayName,
      date: roundInstances.date,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
      status: waitlistEntries.status,
      requestedType: waitlistEntries.requestedType,
      claimExpiresAt: waitlistEntries.claimExpiresAt,
    })
    .from(waitlistEntries)
    .innerJoin(roundInstances, eq(roundInstances.id, waitlistEntries.roundInstanceId))
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(and(eq(waitlistEntries.customerId, customerId), ACTIVE, gte(roundInstances.date, todayIso)));

  return rows
    .map((r) => ({
      entryId: r.entryId,
      roundInstanceId: r.roundInstanceId,
      label: r.label,
      date: r.date,
      startTime: r.startTime.slice(0, 5),
      endTime: r.endTime.slice(0, 5),
      status: r.status as 'waiting' | 'notified',
      requestedType: r.requestedType,
      claimExpiresAt: r.claimExpiresAt ? r.claimExpiresAt.toISOString() : null,
    }))
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
};

export type PromotedEntry = {
  entryId: string;
  customerId: string;
  roundInstanceId: string;
  claimExpiresAt: Date;
  firstName: string;
  phone: string;
  email: string | null;
  roundLabel: string;
  date: string;
  startTime: string;
  endTime: string;
};

export type PromoteWaitlistResult =
  | { promoted: PromotedEntry }
  | { promoted: null; reason: 'no_waiting' | 'no_room' | 'quiet_hours' };

/**
 * on_slot_freed (§8.2): offer a just-freed seat to the FIFO next-in-line. Race
 * safe — it re-checks that a seat is actually free (a concurrent booking may
 * have re-taken it) and takes the next `waiting` entry with FOR UPDATE SKIP
 * LOCKED so two concurrent frees offer to two different people. In active hours
 * it flips the entry to `notified` + claim window and returns who to notify;
 * in quiet hours it leaves the entry waiting for the next active-hours sweep.
 */
export const promoteWaitlist = async (
  db: AnyPgDatabase,
  roundInstanceId: string,
  now: Date = new Date(),
): Promise<PromoteWaitlistResult> => {
  const settings = await getRoundSettings(db);
  return db.transaction(async (tx) => {
    const instRows = await tx
      .select({ capacity: roundInstances.capacity, isClosed: roundInstances.isClosed })
      .from(roundInstances)
      .where(eq(roundInstances.id, roundInstanceId))
      .for('update');
    const inst = instRows[0];
    if (!inst || inst.isClosed) return { promoted: null, reason: 'no_room' as const };
    const taken = await countTaken(tx, roundInstanceId, now);
    if (taken + 1 > inst.capacity) return { promoted: null, reason: 'no_room' as const };

    const nextRows = await tx
      .select({ id: waitlistEntries.id, customerId: waitlistEntries.customerId })
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.roundInstanceId, roundInstanceId), eq(waitlistEntries.status, 'waiting')))
      .orderBy(asc(waitlistEntries.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    const next = nextRows[0];
    if (!next) return { promoted: null, reason: 'no_waiting' as const };

    // Quiet hours: leave the entry waiting; a later active-hours sweep offers it.
    if (!isWithinActiveHours(settings.activeHoursStart, settings.activeHoursEnd, now)) {
      return { promoted: null, reason: 'quiet_hours' as const };
    }

    const claimExpiresAt = new Date(now.getTime() + settings.claimWindowMinutes * 60_000);
    await tx
      .update(waitlistEntries)
      .set({ status: 'notified', notifiedAt: now, claimExpiresAt, updatedAt: now })
      .where(eq(waitlistEntries.id, next.id));

    const infoRows = await tx
      .select({
        firstName: customers.firstName,
        phone: customers.phone,
        email: customers.email,
        roundLabel: rounds.displayName,
        date: roundInstances.date,
        startTime: rounds.startTime,
        endTime: rounds.endTime,
      })
      .from(waitlistEntries)
      .innerJoin(customers, eq(customers.id, waitlistEntries.customerId))
      .innerJoin(roundInstances, eq(roundInstances.id, waitlistEntries.roundInstanceId))
      .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
      .where(eq(waitlistEntries.id, next.id))
      .limit(1);
    const info = infoRows[0];
    if (!info) throw new Error('[waitlist] promoted entry vanished');

    return {
      promoted: {
        entryId: next.id,
        customerId: next.customerId,
        roundInstanceId,
        claimExpiresAt,
        firstName: info.firstName,
        phone: info.phone,
        email: info.email,
        roundLabel: info.roundLabel,
        date: info.date,
        startTime: info.startTime.slice(0, 5),
        endTime: info.endTime.slice(0, 5),
      },
    };
  });
};

/**
 * Close a waitlist offer when the customer actually books that round: any
 * waiting/notified entry for this customer + round becomes `claimed`. Called
 * from the booking paths (mint + punch). Safe to call for non-waitlisted
 * customers — it just matches nothing.
 */
export const markWaitlistClaimed = async (
  db: AnyPgDatabase,
  roundInstanceId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<void> => {
  await db
    .update(waitlistEntries)
    .set({ status: 'claimed', updatedAt: now })
    .where(
      and(
        eq(waitlistEntries.roundInstanceId, roundInstanceId),
        eq(waitlistEntries.customerId, customerId),
        ACTIVE,
      ),
    );
};

/**
 * Expire `notified` offers past their claim window (§8.3). Returns the distinct
 * round ids that lost an offer, so the caller re-promotes each (next in line).
 */
export const expireWaitlistClaims = async (db: AnyPgDatabase, now: Date = new Date()): Promise<string[]> => {
  const expired = await db
    .update(waitlistEntries)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(waitlistEntries.status, 'notified'), lte(waitlistEntries.claimExpiresAt, now)))
    .returning({ roundInstanceId: waitlistEntries.roundInstanceId });
  return [...new Set(expired.map((r) => r.roundInstanceId))];
};
