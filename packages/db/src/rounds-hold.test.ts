// Hold engine tests. The oversell guard's real concurrency (two parallel
// transactions racing FOR UPDATE) can only be proven against real Postgres;
// PGlite is single-connection, so these verify the capacity logic, lazy expiry,
// owner-gated release, and the sweeper. A real-Postgres race test is tracked as
// a follow-up (see the runway plan).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { createRound } from './rounds';
import { createHold, expireHolds, releaseHold } from './rounds-hold';
import { bookings, roundInstances } from './schema';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const NOW = new Date(2026, 6, 1, 10, 0, 0); // 2026-07-01
const TODAY = '2026-07-01';

let phoneSeq = 100;
function phone() {
  phoneSeq += 1;
  return `05000000${phoneSeq}`;
}

async function setup(db: Awaited<ReturnType<typeof freshDb>>, capacity = 2) {
  const r = await createRound(
    db,
    { label: 'afternoon', displayName: 'סבב', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: capacity },
    NOW,
  );
  if (!r.ok) throw new Error('round create failed');
  const inst = (
    await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, r.round.id), eq(roundInstances.date, TODAY)))
      .limit(1)
  )[0];
  if (!inst) throw new Error('no instance');
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  return { instId: inst.id, customerId: cust.id };
}

const ticket = { ticketType: 'child_over_walking' as const };

test('createHold reserves seats and sells out at capacity', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db, 2);
  assert.equal((await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW)).ok, true);
  assert.equal((await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW)).ok, true);
  const third = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.error, 'sold_out');
});

test('createHold rejects a closed instance and a missing instance', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db, 5);
  await db.update(roundInstances).set({ isClosed: true }).where(eq(roundInstances.id, instId));
  const closed = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.error, 'closed');
  const missing = await createHold(
    db,
    { roundInstanceId: '00000000-0000-0000-0000-000000000000', customerId, ...ticket },
    NOW,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, 'not_found');
});

test('lazy expiry: a past-TTL hold frees the seat for a later hold', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db, 1);
  assert.equal((await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW)).ok, true);
  // Same instant: full.
  const blocked = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  assert.equal(blocked.ok, false);
  // 16 min later (TTL 15): the first hold is lazily expired, so this succeeds.
  const later = new Date(NOW.getTime() + 16 * 60_000);
  assert.equal((await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, later)).ok, true);
});

test('releaseHold: owner frees the seat, non-owner is forbidden', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db, 1);
  const other = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });
  const h = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  assert.equal(h.ok, true);
  if (!h.ok) return;

  const forbidden = await releaseHold(db, h.holdId, other.id, NOW);
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error, 'forbidden');

  const released = await releaseHold(db, h.holdId, customerId, NOW);
  assert.equal(released.ok, true);
  // Seat is free again.
  assert.equal((await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW)).ok, true);
  // Re-releasing the now-expired hold is a no-op error.
  const again = await releaseHold(db, h.holdId, customerId, NOW);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error, 'not_held');
});

test('expireHolds flips only past-due holds and is idempotent', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db, 5);
  // one active hold + one manually-inserted past-due hold
  await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  await db.insert(bookings).values({
    roundInstanceId: instId,
    customerId,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'held',
    holdExpiresAt: new Date(NOW.getTime() - 60_000),
  });

  const freed = await expireHolds(db, NOW);
  assert.equal(freed.length, 1, 'only the past-due hold expired');
  assert.equal(freed[0]!.roundInstanceId, instId);

  const again = await expireHolds(db, NOW);
  assert.equal(again.length, 0, 'second sweep finds nothing');
});
