import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getCardSettings } from './card-settings';
import { createCustomer } from './cards';
import { cancelBooking } from './rounds-cancel';
import { createHold } from './rounds-hold';
import { mintBooking } from './rounds-mint';
import { createRound } from './rounds';
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

// A round 10 days out so `now` is unambiguously within the cancel window
// regardless of the machine timezone; AFTER_START is past its start.
const NOW = new Date(2026, 6, 1, 12, 0, 0);
const FUTURE = '2026-07-11';
const AFTER_START = new Date(2026, 6, 12, 12, 0, 0);
let phoneSeq = 600;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function instanceFor(db: Awaited<ReturnType<typeof freshDb>>, roundId: string): Promise<string> {
  const row = (
    await db.select().from(roundInstances).where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, FUTURE))).limit(1)
  )[0];
  if (!row) throw new Error('no future instance');
  return row.id;
}

async function setup(db: Awaited<ReturnType<typeof freshDb>>) {
  const a = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 5 }, NOW);
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id);
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  const hold = await createHold(db, { roundInstanceId: instA, customerId: cust.id, ticketType: 'child_over_walking' }, NOW);
  if (!hold.ok) throw new Error('hold');
  const mint = await mintBooking(db, { holdId: hold.holdId, wcOrderId: 'wc-1001', source: 'paid' }, resolver, NOW);
  if (!mint.ok) throw new Error('mint');
  return { bookingId: mint.booking.bookingId, customerId: cust.id };
}

test('cancelBooking refunds the booking value and releases the seat', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);
  const card = await getCardSettings(db);
  const calls: Array<{ order: string; amount: number }> = [];
  const refund = async (order: string, amount: number) => {
    calls.push({ order, amount });
    return true;
  };
  const res = await cancelBooking(db, { bookingId, customerId }, { refund }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.refunded, true);
  assert.equal(res.refundAmountIls, card.roundChildOverWalkingPriceIls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.order, 'wc-1001');
  assert.equal(calls[0]!.amount, card.roundChildOverWalkingPriceIls);
  const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
  assert.equal(row!.status, 'cancelled');
});

test('cancelBooking does not release the seat when the refund is not confirmed', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);
  const refund = async () => false;
  const res = await cancelBooking(db, { bookingId, customerId }, { refund }, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'refund_failed');
  const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
  assert.equal(row!.status, 'confirmed'); // still the customer's paid seat
});

test('cancelBooking rejects a non-owner without refunding', async () => {
  const db = await freshDb();
  const { bookingId } = await setup(db);
  const other = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });
  let called = false;
  const refund = async () => {
    called = true;
    return true;
  };
  const res = await cancelBooking(db, { bookingId, customerId: other.id }, { refund }, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'forbidden');
  assert.equal(called, false);
});

test('cancelBooking rejects a cancel inside the window without refunding', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);
  let called = false;
  const refund = async () => {
    called = true;
    return true;
  };
  const res = await cancelBooking(db, { bookingId, customerId }, { refund }, AFTER_START);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'too_late');
  assert.equal(called, false);
});

test('cancelBooking is not repeatable — a second cancel does not refund again', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);
  let count = 0;
  const refund = async () => {
    count += 1;
    return true;
  };
  const first = await cancelBooking(db, { bookingId, customerId }, { refund }, NOW);
  assert.equal(first.ok, true);
  const second = await cancelBooking(db, { bookingId, customerId }, { refund }, NOW);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error, 'not_confirmed');
  assert.equal(count, 1);
});
