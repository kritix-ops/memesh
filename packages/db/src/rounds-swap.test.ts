import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { verifyBookingToken, type KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { createRound } from './rounds';
import { mintBooking } from './rounds-mint';
import { createHold } from './rounds-hold';
import { swapBooking } from './rounds-swap';
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

// A round 10 days out so `now` is unambiguously before its start regardless of
// the machine timezone.
const NOW = new Date(2026, 6, 1, 12, 0, 0);
const FUTURE = '2026-07-11';
const AFTER_FUTURE = new Date(2026, 6, 12, 12, 0, 0);
let phoneSeq = 400;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function instanceFor(db: Awaited<ReturnType<typeof freshDb>>, roundId: string): Promise<string> {
  const row = (
    await db.select().from(roundInstances).where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, FUTURE))).limit(1)
  )[0];
  if (!row) throw new Error('no future instance');
  return row.id;
}

async function setup(db: Awaited<ReturnType<typeof freshDb>>, capB = 5) {
  const a = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 5 }, NOW);
  const b = await createRound(db, { label: 'b', displayName: 'B', startTime: '18:00', endTime: '20:00', daysActive: 127, defaultCapacity: capB }, NOW);
  if (!a.ok || !b.ok) throw new Error('rounds');
  const instA = await instanceFor(db, a.round.id);
  const instB = await instanceFor(db, b.round.id);
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  // A confirmed booking on A: hold then mint.
  const hold = await createHold(db, { roundInstanceId: instA, customerId: cust.id, ticketType: 'child_over_walking' }, NOW);
  if (!hold.ok) throw new Error('hold');
  const mint = await mintBooking(db, { holdId: hold.holdId }, resolver, NOW);
  if (!mint.ok) throw new Error('mint');
  return { bookingId: mint.booking.bookingId, customerId: cust.id, instA, instB };
}

test('swapBooking moves the booking, bumps the version, re-mints the barcode', async () => {
  const db = await freshDb();
  const { bookingId, customerId, instB } = await setup(db);
  const res = await swapBooking(db, { bookingId, customerId, targetRoundInstanceId: instB }, resolver, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.barcodeVersion, 2);
  const v = verifyBookingToken(res.barcodeToken, resolver);
  assert.equal(v.ok && v.payload.version, 2);
  const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
  assert.equal(row!.roundInstanceId, instB);
  assert.equal(row!.barcodeVersion, 2);
});

test('swapBooking rejects a non-owner, same-round, and a non-confirmed booking', async () => {
  const db = await freshDb();
  const { bookingId, customerId, instA, instB } = await setup(db);
  const other = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });

  const forbidden = await swapBooking(db, { bookingId, customerId: other.id, targetRoundInstanceId: instB }, resolver, NOW);
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error, 'forbidden');

  const same = await swapBooking(db, { bookingId, customerId, targetRoundInstanceId: instA }, resolver, NOW);
  assert.equal(same.ok, false);
  if (!same.ok) assert.equal(same.error, 'same_round');
});

test('swapBooking rejects a full target', async () => {
  const db = await freshDb();
  const { bookingId, customerId, instB } = await setup(db, 1);
  // Fill B's single seat with someone else's confirmed booking.
  const filler = await createCustomer(db, { firstName: 'ה', lastName: 'ו', phone: phone() });
  await db.insert(bookings).values({ roundInstanceId: instB, customerId: filler.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: NOW, barcodeToken: 'filler' });
  const res = await swapBooking(db, { bookingId, customerId, targetRoundInstanceId: instB }, resolver, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'target_full');
});

test('swapBooking rejects a swap after the original round has started', async () => {
  const db = await freshDb();
  const { bookingId, customerId, instB } = await setup(db);
  const res = await swapBooking(db, { bookingId, customerId, targetRoundInstanceId: instB }, resolver, AFTER_FUTURE);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'too_late');
});
