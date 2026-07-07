import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { createRound, listRoundAttendees, listUpcomingReservationsForCustomer } from './rounds';
import { addWalkInBooking } from './rounds-walkin';
import { bookings, roundInstances } from './schema';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const SECRET = 'a-booking-secret-at-least-32-chars!!';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (id) => (id === '1' ? SECRET : undefined),
};

const NOW = new Date(2026, 6, 1, 12, 0, 0);
const FUTURE = '2026-07-11';
let phoneSeq = 900;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function setup(db: Awaited<ReturnType<typeof freshDb>>, capacity: number) {
  const r = await createRound(
    db,
    { label: 'a', displayName: 'סבב בוקר', startTime: '09:00', endTime: '14:00', daysActive: 127, defaultCapacity: capacity },
    NOW,
  );
  if (!r.ok) throw new Error('round');
  const inst = (
    await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, r.round.id), eq(roundInstances.date, FUTURE)))
      .limit(1)
  )[0];
  if (!inst) throw new Error('instance');
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  return { instanceId: inst.id, customerId: cust.id };
}

test('addWalkInBooking: adds a confirmed manual booking with a barcode and number', async () => {
  const db = await freshDb();
  const { instanceId, customerId } = await setup(db, 5);
  const res = await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: true }, resolver, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.overCapacity, false);
  assert.equal(res.taken, 1);
  assert.match(res.bookingNumber, /^R-\d{8}-\d{4}$/);
  assert.ok(res.barcodeToken.length > 0);

  const row = (await db.select().from(bookings).where(eq(bookings.id, res.bookingId)).limit(1))[0];
  assert.equal(row!.source, 'manual');
  assert.equal(row!.status, 'confirmed');
});

test('addWalkInBooking: a full round still takes a walk-in when allowed, flagged over capacity', async () => {
  const db = await freshDb();
  const { instanceId, customerId } = await setup(db, 1);
  const first = await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: true }, resolver, NOW);
  assert.equal(first.ok, true);
  // Second add pushes past capacity 1.
  const second = await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: true }, resolver, NOW);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.overCapacity, true);
  assert.equal(second.taken, 2);
  assert.equal(second.capacity, 1);
});

test('addWalkInBooking: a full round refuses when over-capacity is disallowed', async () => {
  const db = await freshDb();
  const { instanceId, customerId } = await setup(db, 1);
  await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: true }, resolver, NOW);
  const blocked = await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: false }, resolver, NOW);
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error, 'round_full');
  // Nothing extra inserted — still exactly the one from the first add.
  const rows = await db.select().from(bookings).where(eq(bookings.roundInstanceId, instanceId));
  assert.equal(rows.length, 1);
});

test('addWalkInBooking: refuses a closed instance', async () => {
  const db = await freshDb();
  const { instanceId, customerId } = await setup(db, 5);
  await db.update(roundInstances).set({ isClosed: true }).where(eq(roundInstances.id, instanceId));
  const res = await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: true }, resolver, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'round_closed');
});

test('addWalkInBooking: refuses an unknown customer', async () => {
  const db = await freshDb();
  const { instanceId } = await setup(db, 5);
  const res = await addWalkInBooking(
    db,
    { roundInstanceId: instanceId, customerId: '00000000-0000-0000-0000-000000000000', allowOverCapacity: true },
    resolver,
    NOW,
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'customer_not_found');
});

test('addWalkInBooking: the walk-in shows in attendees marked source=manual', async () => {
  const db = await freshDb();
  const { instanceId, customerId } = await setup(db, 5);
  await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: true }, resolver, NOW);
  const attendees = await listRoundAttendees(db, instanceId);
  assert.equal(attendees.length, 1);
  assert.equal(attendees[0]!.source, 'manual');
});

test('listUpcomingReservationsForCustomer: returns confirmed future reservations, soonest first', async () => {
  const db = await freshDb();
  const { instanceId, customerId } = await setup(db, 5);
  await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: true }, resolver, NOW);
  const upcoming = await listUpcomingReservationsForCustomer(db, customerId, NOW);
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0]!.date, FUTURE);
  assert.equal(upcoming[0]!.startTime, '09:00');
  assert.equal(upcoming[0]!.source, 'manual');
});

test('listUpcomingReservationsForCustomer: a cancelled reservation is not upcoming', async () => {
  const db = await freshDb();
  const { instanceId, customerId } = await setup(db, 5);
  const res = await addWalkInBooking(db, { roundInstanceId: instanceId, customerId, allowOverCapacity: true }, resolver, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, res.bookingId));
  const upcoming = await listUpcomingReservationsForCustomer(db, customerId, NOW);
  assert.equal(upcoming.length, 0);
});
