// Manual arrival marking (plan 2026-07-05-staff-manual-arrival): the mark /
// undo transitions, the same-venue-day guard, and the per-customer day list
// that powers the POS "mark them in" screen.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer, createPunchCard } from './cards';
import { listCustomerRoundBookingsForDate, setBookingArrival } from './rounds-arrival';
import { bookRoundWithPunch } from './rounds-punch';
import { createRound } from './rounds';
import { bookings, roundInstances } from './schema';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const SECRET = 'an-arrival-secret-at-least-32-chars!';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (id) => (id === '1' ? SECRET : undefined),
};

const NOW = new Date(2026, 6, 1, 12, 0, 0);
const ROUND_DAY = '2026-07-11';
// Explicit +03:00 offsets so venueTodayIso is deterministic on any machine tz.
const ON_ROUND_DAY = new Date('2026-07-11T09:30:00+03:00');
const DAY_BEFORE = new Date('2026-07-10T09:30:00+03:00');
let phoneSeq = 970;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function instanceOn(db: Awaited<ReturnType<typeof freshDb>>, roundId: string, date: string) {
  const row = (
    await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, date)))
      .limit(1)
  )[0];
  if (!row) throw new Error(`no instance on ${date}`);
  return row.id;
}

/** A confirmed punch booking on ROUND_DAY + its owner and round. */
async function setup(db: Awaited<ReturnType<typeof freshDb>>) {
  const r = await createRound(
    db,
    { label: 'a', displayName: 'בוקר', startTime: '09:00', endTime: '14:00', daysActive: 127, defaultCapacity: 5 },
    NOW,
  );
  if (!r.ok) throw new Error('round');
  const inst = await instanceOn(db, r.round.id, ROUND_DAY);
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, totalEntries: 12, validityDays: 0, now: NOW });
  const booked = await bookRoundWithPunch(
    db,
    { roundInstanceId: inst, customerId: cust.id, punchCardId: card.id, ticketType: 'child_over_walking' },
    resolver,
    NOW,
  );
  if (!booked.ok) throw new Error('book');
  return { bookingId: booked.bookings[0]!.bookingId, customerId: cust.id, roundId: r.round.id, punchCardId: card.id };
}

test('setBookingArrival marks a confirmed booking used with a check-in time', async () => {
  const db = await freshDb();
  const { bookingId } = await setup(db);
  const res = await setBookingArrival(db, { bookingId, arrived: true }, ON_ROUND_DAY);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.arrived, true);
  assert.equal(res.changed, true);
  assert.ok(res.usedAt);

  const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
  assert.equal(row!.status, 'used');
  assert.ok(row!.usedAt);
});

test('setBookingArrival replays idempotently in both directions', async () => {
  const db = await freshDb();
  const { bookingId } = await setup(db);
  const first = await setBookingArrival(db, { bookingId, arrived: true }, ON_ROUND_DAY);
  assert.equal(first.ok && first.changed, true);
  const replay = await setBookingArrival(db, { bookingId, arrived: true }, ON_ROUND_DAY);
  assert.equal(replay.ok && !replay.changed, true);

  const undoNoop = await setBookingArrival(db, { bookingId: (await setup(db)).bookingId, arrived: false }, ON_ROUND_DAY);
  assert.equal(undoNoop.ok && !undoNoop.changed, true); // never arrived — nothing to undo
});

test('setBookingArrival undo restores confirmed and clears the check-in time', async () => {
  const db = await freshDb();
  const { bookingId } = await setup(db);
  await setBookingArrival(db, { bookingId, arrived: true }, ON_ROUND_DAY);
  const undo = await setBookingArrival(db, { bookingId, arrived: false }, ON_ROUND_DAY);
  assert.equal(undo.ok, true);
  if (!undo.ok) return;
  assert.equal(undo.changed, true);
  assert.equal(undo.usedAt, null);

  const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
  assert.equal(row!.status, 'confirmed');
  assert.equal(row!.usedAt, null);
});

test('setBookingArrival refuses other days, cancelled bookings, and unknown ids', async () => {
  const db = await freshDb();
  const { bookingId } = await setup(db);

  const wrongDay = await setBookingArrival(db, { bookingId, arrived: true }, DAY_BEFORE);
  assert.equal(wrongDay.ok, false);
  if (!wrongDay.ok) assert.equal(wrongDay.error, 'not_today');

  await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, bookingId));
  const cancelled = await setBookingArrival(db, { bookingId, arrived: true }, ON_ROUND_DAY);
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error, 'not_markable');

  const missing = await setBookingArrival(
    db,
    { bookingId: '00000000-0000-0000-0000-000000000000', arrived: true },
    ON_ROUND_DAY,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, 'not_found');
});

test('listCustomerRoundBookingsForDate returns only that date, sorted, with arrival state', async () => {
  const db = await freshDb();
  const { bookingId, customerId, punchCardId } = await setup(db);

  // A second, later round on the same day + a booking on the NEXT day.
  const r2 = await createRound(
    db,
    { label: 'b', displayName: 'ערב', startTime: '17:00', endTime: '20:00', daysActive: 127, defaultCapacity: 5 },
    NOW,
  );
  if (!r2.ok) throw new Error('round2');
  const eveningInst = await instanceOn(db, r2.round.id, ROUND_DAY);
  const evening = await bookRoundWithPunch(
    db,
    { roundInstanceId: eveningInst, customerId, punchCardId, ticketType: 'child_over_walking' },
    resolver,
    NOW,
  );
  assert.equal(evening.ok, true);
  const nextDayInst = await instanceOn(db, r2.round.id, '2026-07-12');
  const nextDay = await bookRoundWithPunch(
    db,
    { roundInstanceId: nextDayInst, customerId, punchCardId, ticketType: 'child_over_walking' },
    resolver,
    NOW,
  );
  assert.equal(nextDay.ok, true);

  await setBookingArrival(db, { bookingId, arrived: true }, ON_ROUND_DAY);

  const list = await listCustomerRoundBookingsForDate(db, customerId, ROUND_DAY);
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((b) => b.label),
    ['בוקר', 'ערב'],
  );
  assert.equal(list[0]!.arrived, true);
  assert.ok(list[0]!.usedAt);
  assert.equal(list[1]!.arrived, false);
  assert.equal(list[1]!.usedAt, null);
});
