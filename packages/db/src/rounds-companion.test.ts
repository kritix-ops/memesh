// Tests for the paid-extra-companion upsell on punch-card bookings
// (plan 2026-07-02-punch-companion-upsell): checkout validation, order
// stamping, paid-order confirmation idempotency, and the cancel-with-refund
// path the companion adds to punchcard bookings.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getCardSettings } from './card-settings';
import { createCustomer, createPunchCard } from './cards';
import { cancelBooking } from './rounds-cancel';
import {
  confirmCompanionUpgrade,
  prepareCompanionCheckout,
  recordCompanionOrder,
} from './rounds-companion';
import { bookRoundWithPunch } from './rounds-punch';
import { createRound, listCustomerRoundBookings } from './rounds';
import { bookings, punchCards, roundInstances } from './schema';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const SECRET = 'a-companion-secret-at-least-32-chars';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (id) => (id === '1' ? SECRET : undefined),
};

const NOW = new Date(2026, 6, 1, 12, 0, 0);
const FUTURE = '2026-07-11';
let phoneSeq = 800;
const phone = () => `05000000${(phoneSeq += 1)}`;

/** A confirmed punch-card booking on a future round + its owner. */
async function setup(db: Awaited<ReturnType<typeof freshDb>>) {
  const r = await createRound(
    db,
    { label: 'a', displayName: 'סבב א', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 5 },
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
  if (!inst) throw new Error('no instance');
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  const card = await createPunchCard(db, resolver, {
    customerId: cust.id,
    totalEntries: 12,
    validityDays: 0,
    now: NOW,
  });
  const booked = await bookRoundWithPunch(
    db,
    { roundInstanceId: inst.id, customerId: cust.id, punchCardId: card.id, ticketType: 'child_over_walking' },
    resolver,
    NOW,
  );
  if (!booked.ok) throw new Error('book');
  return { bookingId: booked.bookings[0]!.bookingId, customerId: cust.id, cardId: card.id };
}

// ---------------------------------------------------------------------------
// prepareCompanionCheckout
// ---------------------------------------------------------------------------

test('prepare: returns round display data and the settings price for a valid punch booking', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);
  const settings = await getCardSettings(db);
  const res = await prepareCompanionCheckout(db, { bookingId, customerId });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.booking.id, bookingId);
  assert.equal(res.booking.wcOrderId, null);
  assert.equal(res.booking.roundLabel, 'סבב א');
  assert.equal(res.booking.date, FUTURE);
  assert.equal(res.booking.startTime, '16:00');
  assert.equal(res.priceIls, settings.roundAdditionalCompanionPriceIls);
});

test('prepare: rejects non-owner, missing booking, and already-companioned bookings', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);

  const other = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });
  const forbidden = await prepareCompanionCheckout(db, { bookingId, customerId: other.id });
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error, 'forbidden');

  const missing = await prepareCompanionCheckout(db, {
    bookingId: '00000000-0000-0000-0000-000000000000',
    customerId,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, 'not_found');

  await db.update(bookings).set({ additionalCompanions: 1 }).where(eq(bookings.id, bookingId));
  const dup = await prepareCompanionCheckout(db, { bookingId, customerId });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.error, 'already_has_companion');
});

test('prepare: rejects non-punchcard bookings (paid bookings keep their own wc_order_id)', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);
  await db.update(bookings).set({ source: 'paid' }).where(eq(bookings.id, bookingId));
  const res = await prepareCompanionCheckout(db, { bookingId, customerId });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'not_punchcard');
});

// ---------------------------------------------------------------------------
// recordCompanionOrder + confirmCompanionUpgrade
// ---------------------------------------------------------------------------

test('record + confirm: pending order is stamped, paid order flips companions to 1', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);

  const stamped = await recordCompanionOrder(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  assert.equal(stamped.ok, true);

  // Pending state is visible to the personal area.
  const listed = await listCustomerRoundBookings(db, customerId, {}, NOW);
  const mine = listed.find((b) => b.bookingId === bookingId);
  assert.equal(mine?.companionPending, true);
  assert.equal(mine?.additionalCompanions, 0);

  const confirmed = await confirmCompanionUpgrade(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) assert.equal(confirmed.replayed, false);

  const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
  assert.equal(row!.additionalCompanions, 1);
  assert.equal(row!.wcOrderId, 'wc-777');

  const after = await listCustomerRoundBookings(db, customerId, {}, NOW);
  assert.equal(after.find((b) => b.bookingId === bookingId)?.companionPending, false);
});

test('confirm: re-delivered webhook replays as a no-op; a different order id is a conflict', async () => {
  const db = await freshDb();
  const { bookingId } = await setup(db);
  await recordCompanionOrder(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  await confirmCompanionUpgrade(db, { bookingId, wcOrderId: 'wc-777' }, NOW);

  const replay = await confirmCompanionUpgrade(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.replayed, true);

  const conflict = await confirmCompanionUpgrade(db, { bookingId, wcOrderId: 'wc-888' }, NOW);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error, 'order_mismatch');

  const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
  assert.equal(row!.additionalCompanions, 1); // never double-applied
});

test('confirm: a paid order landing on a cancelled booking is surfaced, not absorbed', async () => {
  const db = await freshDb();
  const { bookingId } = await setup(db);
  await recordCompanionOrder(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, bookingId));

  const res = await confirmCompanionUpgrade(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'booking_cancelled');
});

// ---------------------------------------------------------------------------
// cancelBooking with a companion on a punch booking
// ---------------------------------------------------------------------------

test('cancel: refunds the companion price AND returns the punch, seat released', async () => {
  const db = await freshDb();
  const { bookingId, customerId, cardId } = await setup(db);
  await recordCompanionOrder(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  await confirmCompanionUpgrade(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  const settings = await getCardSettings(db);

  const calls: Array<{ order: string; amount: number }> = [];
  const refund = async (order: string, amount: number) => {
    calls.push({ order, amount });
    return true;
  };
  const res = await cancelBooking(db, { bookingId, customerId }, { refund }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.refunded, true);
  assert.equal(res.punchReturned, true);
  assert.equal(res.refundAmountIls, settings.roundAdditionalCompanionPriceIls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.order, 'wc-777');

  const card = (await db.select().from(punchCards).where(eq(punchCards.id, cardId)).limit(1))[0];
  assert.equal(card!.usedEntries, 0); // punch returned too
});

test('cancel: companion refund failure keeps the booking (fail closed, punch NOT returned)', async () => {
  const db = await freshDb();
  const { bookingId, customerId, cardId } = await setup(db);
  await recordCompanionOrder(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  await confirmCompanionUpgrade(db, { bookingId, wcOrderId: 'wc-777' }, NOW);

  const res = await cancelBooking(db, { bookingId, customerId }, { refund: async () => false }, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'refund_failed');

  const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
  assert.equal(row!.status, 'confirmed');
  const card = (await db.select().from(punchCards).where(eq(punchCards.id, cardId)).limit(1))[0];
  assert.equal(card!.usedEntries, 1); // punch still spent — nothing changed
});

test('cancel: an unpaid pending companion order refunds nothing (punch still returned)', async () => {
  const db = await freshDb();
  const { bookingId, customerId } = await setup(db);
  await recordCompanionOrder(db, { bookingId, wcOrderId: 'wc-777' }, NOW);
  // additional_companions is still 0 — the order was never paid.

  let called = false;
  const refund = async () => {
    called = true;
    return true;
  };
  const res = await cancelBooking(db, { bookingId, customerId }, { refund }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.refunded, false);
  assert.equal(res.punchReturned, true);
  assert.equal(called, false); // no money ever moved, nothing to refund
});
