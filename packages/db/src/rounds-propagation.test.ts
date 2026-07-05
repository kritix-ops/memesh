// Template-edit propagation (plan 2026-07-05-booking-window-365): with the
// instance horizon at a full year, a capacity edit or a removed weekday must
// reach future instances deterministically instead of waiting for old rows to
// age out. Uses the PGlite fixture like rounds-crud.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { createRound, updateRound, type RoundInput } from './rounds';
import { bookings, roundInstances, waitlistEntries } from './schema';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const baseInput: RoundInput = {
  label: 'afternoon',
  displayName: 'סבב אחר הצהריים',
  startTime: '16:00',
  endTime: '18:00',
  daysActive: 127,
  defaultCapacity: 50,
};

// Same fixed instant as rounds-crud.test.ts: venue date 2026-07-01, a
// Wednesday, in every machine TZ.
const NOW = new Date('2026-07-01T07:00:00Z');

type Db = Awaited<ReturnType<typeof freshDb>>;

async function instanceOn(db: Db, roundId: string, date: string) {
  const rows = await db
    .select()
    .from(roundInstances)
    .where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, date)))
    .limit(1);
  const inst = rows[0];
  if (!inst) throw new Error(`expected instance on ${date}`);
  return inst;
}

async function bookSeat(db: Db, roundInstanceId: string, phone: string) {
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone });
  await db.insert(bookings).values({
    roundInstanceId,
    customerId: cust.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'confirmed',
    confirmedAt: NOW,
  });
}

test('capacity edit reaches every future non-overridden unbooked instance', async () => {
  const db = await freshDb();
  const created = await createRound(db, baseInput, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const res = await updateRound(db, created.round.id, { defaultCapacity: 80 }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.propagation.capacityUpdated, 365, 'the whole window follows the template');
  assert.deepEqual(res.propagation.capacityKeptDates, []);

  const far = await instanceOn(db, created.round.id, '2027-05-01');
  assert.equal(far.capacity, 80, 'a date ten months out got the new capacity');
});

test('a second capacity edit still propagates (no old-default guessing)', async () => {
  const db = await freshDb();
  const created = await createRound(db, baseInput, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  await updateRound(db, created.round.id, { defaultCapacity: 60 }, NOW);
  const second = await updateRound(db, created.round.id, { defaultCapacity: 70 }, NOW);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.propagation.capacityUpdated, 365);

  const far = await instanceOn(db, created.round.id, '2026-12-15');
  assert.equal(far.capacity, 70);
});

test('booked dates keep their capacity and come back in the report', async () => {
  const db = await freshDb();
  const created = await createRound(db, { ...baseInput, defaultCapacity: 10 }, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const booked = await instanceOn(db, created.round.id, '2026-08-20');
  await bookSeat(db, booked.id, '0500000401');

  const res = await updateRound(db, created.round.id, { defaultCapacity: 25 }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.propagation.capacityUpdated, 364);
  assert.deepEqual(res.propagation.capacityKeptDates, ['2026-08-20']);

  assert.equal((await instanceOn(db, created.round.id, '2026-08-20')).capacity, 10, 'kept');
  assert.equal((await instanceOn(db, created.round.id, '2026-08-21')).capacity, 25, 'updated');
});

test('a cancelled-only date follows the template like an empty one', async () => {
  const db = await freshDb();
  const created = await createRound(db, { ...baseInput, defaultCapacity: 10 }, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const inst = await instanceOn(db, created.round.id, '2026-09-01');
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: '0500000402' });
  await db.insert(bookings).values({
    roundInstanceId: inst.id,
    customerId: cust.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'cancelled',
  });

  const res = await updateRound(db, created.round.id, { defaultCapacity: 25 }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.propagation.capacityKeptDates, [], 'no seats there to protect');
  assert.equal((await instanceOn(db, created.round.id, '2026-09-01')).capacity, 25);
});

test('a hand-overridden date survives the sweep silently', async () => {
  const db = await freshDb();
  const created = await createRound(db, baseInput, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const special = await instanceOn(db, created.round.id, '2026-10-10');
  await db
    .update(roundInstances)
    .set({ capacity: 5, capacityOverridden: true })
    .where(eq(roundInstances.id, special.id));

  const res = await updateRound(db, created.round.id, { defaultCapacity: 80 }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.propagation.capacityUpdated, 364);
  assert.deepEqual(res.propagation.capacityKeptDates, [], 'an override is expected, not news');
  assert.equal((await instanceOn(db, created.round.id, '2026-10-10')).capacity, 5);
});

test('removing a weekday deletes its unbooked future instances (waitlist rows too)', async () => {
  const db = await freshDb();
  const created = await createRound(db, baseInput, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // Park a waitlist entry on a Saturday instance to prove dependents go too.
  const sat = await instanceOn(db, created.round.id, '2026-07-04');
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: '0500000403' });
  await db.insert(waitlistEntries).values({
    roundInstanceId: sat.id,
    customerId: cust.id,
    requestedType: 'child_over_walking',
  });

  // Drop Saturday (bit 6): 127 → 63.
  const res = await updateRound(db, created.round.id, { daysActive: 63 }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // 2026-07-01 is a Wednesday, so the 365-day window holds 52 Saturdays.
  assert.equal(res.propagation.instancesRemoved, 52);
  assert.deepEqual(res.propagation.removedDayKeptDates, []);

  const left = await db
    .select({ date: roundInstances.date })
    .from(roundInstances)
    .where(eq(roundInstances.roundId, created.round.id));
  assert.equal(left.some((r) => r.date === '2026-07-04'), false, 'Saturdays are gone');
  assert.equal(left.length, 365 - 52);
});

test('a booked date on a removed weekday is kept and reported', async () => {
  const db = await freshDb();
  const created = await createRound(db, baseInput, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const sat = await instanceOn(db, created.round.id, '2026-07-11');
  await bookSeat(db, sat.id, '0500000404');

  const res = await updateRound(db, created.round.id, { daysActive: 63 }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.propagation.instancesRemoved, 51, 'every Saturday but the booked one');
  assert.deepEqual(res.propagation.removedDayKeptDates, ['2026-07-11']);
  assert.ok(await instanceOn(db, created.round.id, '2026-07-11'), 'the booked date survives');
});

test('an edit with no capacity/weekday change propagates nothing', async () => {
  const db = await freshDb();
  const created = await createRound(db, baseInput, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const res = await updateRound(db, created.round.id, { displayName: 'סבב ערב' }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.propagation, {
    capacityUpdated: 0,
    capacityKeptDates: [],
    instancesRemoved: 0,
    removedDayKeptDates: [],
  });
});
