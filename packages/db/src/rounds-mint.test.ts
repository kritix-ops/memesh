import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { verifyBookingToken, type KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { createRound } from './rounds';
import { createHold } from './rounds-hold';
import { mintBooking } from './rounds-mint';
import { bookings, roundInstances } from './schema';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const SECRET = 'a-booking-secret-at-least-32-chars!!';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (keyId) => (keyId === '1' ? SECRET : undefined),
};

const NOW = new Date(2026, 6, 1, 10, 0, 0);
const TODAY = '2026-07-01';
let phoneSeq = 200;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function setup(db: Awaited<ReturnType<typeof freshDb>>, capacity = 5) {
  const r = await createRound(
    db,
    { label: 'a', displayName: 'סבב', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: capacity },
    NOW,
  );
  if (!r.ok) throw new Error('round');
  const inst = (
    await db.select().from(roundInstances).where(and(eq(roundInstances.roundId, r.round.id), eq(roundInstances.date, TODAY))).limit(1)
  )[0];
  if (!inst) throw new Error('instance');
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  return { instId: inst.id, customerId: cust.id };
}

const ticket = { ticketType: 'child_over_walking' as const };

test('mintBooking confirms a valid hold and signs a verifiable barcode', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db);
  const hold = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  assert.equal(hold.ok, true);
  if (!hold.ok) return;

  const res = await mintBooking(db, { holdId: hold.holdId, wcOrderId: 'wc-1' }, resolver, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.idempotentReplay, false);

  const v = verifyBookingToken(res.booking.barcodeToken, resolver);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.payload.bookingId, res.booking.bookingId);
  assert.equal(v.payload.version, 1);

  const row = (await db.select().from(bookings).where(eq(bookings.id, res.booking.bookingId)).limit(1))[0];
  assert.equal(row!.status, 'confirmed');
  assert.equal(row!.wcOrderId, 'wc-1');
  assert.equal(row!.holdExpiresAt, null);
});

test('mintBooking is idempotent — a second mint returns the same booking', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db);
  const hold = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  if (!hold.ok) return;
  const first = await mintBooking(db, { holdId: hold.holdId, wcOrderId: 'wc-2' }, resolver, NOW);
  const second = await mintBooking(db, { holdId: hold.holdId, wcOrderId: 'wc-2' }, resolver, NOW);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.booking.barcodeToken, first.booking.barcodeToken);
});

test('mintBooking on a missing hold returns not_found', async () => {
  const db = await freshDb();
  const res = await mintBooking(db, { holdId: '00000000-0000-0000-0000-000000000000' }, resolver, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'not_found');
});

test('mintBooking on a cancelled booking returns cancelled (not not_found)', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db);
  const hold = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  if (!hold.ok) return;
  const minted = await mintBooking(db, { holdId: hold.holdId, wcOrderId: 'wc-3' }, resolver, NOW);
  assert.equal(minted.ok, true);
  // The customer cancels; then a paid-order webhook re-delivers for this hold.
  await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, hold.holdId));
  const replay = await mintBooking(db, { holdId: hold.holdId, wcOrderId: 'wc-3' }, resolver, NOW);
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.error, 'cancelled'); // a distinct, non-orphan signal
});

test('mintBooking snapshots paidTicketIls onto the booking when given', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db);
  const hold = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  if (!hold.ok) return;
  const res = await mintBooking(db, { holdId: hold.holdId, wcOrderId: 'wc-4', paidTicketIls: 55 }, resolver, NOW);
  assert.equal(res.ok, true);
  const row = (await db.select().from(bookings).where(eq(bookings.id, hold.holdId)).limit(1))[0];
  assert.equal(row!.paidTicketIls, 55);
});

test('mintBooking recovers an expired hold when a seat is still free', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db, 2);
  const hold = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  if (!hold.ok) return;
  // Mint 16 min later: the hold has expired (TTL 15) but the instance has room.
  const later = new Date(NOW.getTime() + 16 * 60_000);
  const res = await mintBooking(db, { holdId: hold.holdId }, resolver, later);
  assert.equal(res.ok, true, 'confirmed despite the expired hold, because there was room');
});

test('mintBooking rejects an expired hold when the seat was taken (sold_out_after_payment)', async () => {
  const db = await freshDb();
  const { instId, customerId } = await setup(db, 1);
  const hold = await createHold(db, { roundInstanceId: instId, customerId, ...ticket }, NOW);
  if (!hold.ok) return;
  // Someone else's booking fills the single seat.
  const other = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });
  await db.insert(bookings).values({
    roundInstanceId: instId,
    customerId: other.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'confirmed',
    confirmedAt: NOW,
    barcodeToken: 'other-token',
  });
  // Mint the original hold after it expired: no room left.
  const later = new Date(NOW.getTime() + 16 * 60_000);
  const res = await mintBooking(db, { holdId: hold.holdId }, resolver, later);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'sold_out_after_payment');
});
