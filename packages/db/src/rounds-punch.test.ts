import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { verifyBookingToken, type KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer, createPunchCard } from './cards';
import { bookRoundWithPunch } from './rounds-punch';
import { createRound } from './rounds';
import { bookings, punchCardEntries, punchCards, roundInstances } from './schema';

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
let phoneSeq = 700;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function instanceFor(db: Awaited<ReturnType<typeof freshDb>>, roundId: string): Promise<string> {
  const row = (
    await db.select().from(roundInstances).where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, FUTURE))).limit(1)
  )[0];
  if (!row) throw new Error('no future instance');
  return row.id;
}

async function setup(db: Awaited<ReturnType<typeof freshDb>>, cap = 5, totalEntries = 12) {
  const r = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: cap }, NOW);
  if (!r.ok) throw new Error('round');
  const inst = await instanceFor(db, r.round.id);
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  const cardRow = await createPunchCard(db, resolver, { customerId: cust.id, totalEntries, validityDays: 0, now: NOW });
  return { inst, customerId: cust.id, punchCardId: cardRow.id };
}

test('bookRoundWithPunch confirms the booking, mints a barcode, and punches the card', async () => {
  const db = await freshDb();
  const { inst, customerId, punchCardId } = await setup(db);
  const res = await bookRoundWithPunch(db, { roundInstanceId: inst, customerId, punchCardId, ticketType: 'child_over_walking' }, resolver, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.remaining, 11);

  const v = verifyBookingToken(res.barcodeToken, resolver);
  assert.equal(v.ok && v.payload.bookingId, res.bookingId);

  const booking = (await db.select().from(bookings).where(eq(bookings.id, res.bookingId)).limit(1))[0];
  assert.equal(booking!.status, 'confirmed');
  assert.equal(booking!.source, 'punchcard');
  assert.equal(booking!.punchCardId, punchCardId);

  const cardRow = (await db.select().from(punchCards).where(eq(punchCards.id, punchCardId)).limit(1))[0];
  assert.equal(cardRow!.usedEntries, 1);

  const entry = (await db.select().from(punchCardEntries).where(eq(punchCardEntries.idempotencyKey, res.bookingId)).limit(1))[0];
  assert.equal(entry!.method, 'online');
  assert.equal(entry!.entriesConsumed, 1);
});

test('bookRoundWithPunch rejects a card the customer does not own', async () => {
  const db = await freshDb();
  const { inst, punchCardId } = await setup(db);
  const other = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });
  const res = await bookRoundWithPunch(db, { roundInstanceId: inst, customerId: other.id, punchCardId, ticketType: 'child_over_walking' }, resolver, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'card_forbidden');
});

test('bookRoundWithPunch deactivates a one-entry card and rejects the next booking', async () => {
  const db = await freshDb();
  const { inst, customerId, punchCardId } = await setup(db, 5, 1);
  const first = await bookRoundWithPunch(db, { roundInstanceId: inst, customerId, punchCardId, ticketType: 'child_over_walking' }, resolver, NOW);
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.remaining, 0);
  const cardRow = (await db.select().from(punchCards).where(eq(punchCards.id, punchCardId)).limit(1))[0];
  assert.equal(cardRow!.isActive, false); // exhausted → deactivated

  const second = await bookRoundWithPunch(db, { roundInstanceId: inst, customerId, punchCardId, ticketType: 'child_over_walking' }, resolver, NOW);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error, 'card_inactive');
});

test('bookRoundWithPunch rejects a full round without punching', async () => {
  const db = await freshDb();
  const { inst, customerId, punchCardId } = await setup(db, 1);
  // Fill the single seat with someone else's confirmed booking.
  const filler = await createCustomer(db, { firstName: 'ה', lastName: 'ו', phone: phone() });
  await db.insert(bookings).values({ roundInstanceId: inst, customerId: filler.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: NOW, barcodeToken: 'filler-punch' });
  const res = await bookRoundWithPunch(db, { roundInstanceId: inst, customerId, punchCardId, ticketType: 'child_over_walking' }, resolver, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'round_full');
  const cardRow = (await db.select().from(punchCards).where(eq(punchCards.id, punchCardId)).limit(1))[0];
  assert.equal(cardRow!.usedEntries, 0); // no punch spent on a failed booking
});

test('bookRoundWithPunch rejects a closed round', async () => {
  const db = await freshDb();
  const { inst, customerId, punchCardId } = await setup(db);
  await db.update(roundInstances).set({ isClosed: true }).where(eq(roundInstances.id, inst));
  const res = await bookRoundWithPunch(db, { roundInstanceId: inst, customerId, punchCardId, ticketType: 'child_over_walking' }, resolver, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'round_closed');
});
