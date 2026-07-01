import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { createRound } from './rounds';
import {
  expireWaitlistClaims,
  joinWaitlist,
  leaveWaitlist,
  markWaitlistClaimed,
  promoteWaitlist,
} from './rounds-waitlist';
import { bookings, roundInstances, waitlistEntries } from './schema';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

// Absolute instants so the venue-hour (active/quiet) check is deterministic on
// any machine timezone. Jerusalem is UTC+3 in July: 10:00Z → 13:00 (active),
// 02:00Z → 05:00 (quiet). Active window default 08:00-22:00.
const ACTIVE = new Date('2026-07-01T10:00:00Z');
const ACTIVE_LATER = new Date('2026-07-01T10:05:00Z');
const ACTIVE_PROMOTE = new Date('2026-07-01T10:10:00Z');
const QUIET = new Date('2026-07-01T02:00:00Z');
const FUTURE = '2026-07-11';
let phoneSeq = 800;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function instanceFor(db: Awaited<ReturnType<typeof freshDb>>, roundId: string): Promise<string> {
  const row = (
    await db.select().from(roundInstances).where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, FUTURE))).limit(1)
  )[0];
  if (!row) throw new Error('no future instance');
  return row.id;
}

// A capacity-1 round, filled by someone else's confirmed booking so it's full.
async function fullRound(db: Awaited<ReturnType<typeof freshDb>>) {
  const r = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 1 }, ACTIVE);
  if (!r.ok) throw new Error('round');
  const inst = await instanceFor(db, r.round.id);
  const filler = await createCustomer(db, { firstName: 'מ', lastName: 'לא', phone: phone() });
  const fb = await db
    .insert(bookings)
    .values({ roundInstanceId: inst, customerId: filler.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: ACTIVE, barcodeToken: `filler-${phone()}` })
    .returning({ id: bookings.id });
  return { inst, fillerBookingId: fb[0]!.id };
}

const freeSeat = (db: Awaited<ReturnType<typeof freshDb>>, bookingId: string) =>
  db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, bookingId));

test('joinWaitlist refuses when there is room, accepts when full, and is idempotent', async () => {
  const db = await freshDb();
  const r = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 1 }, ACTIVE);
  if (!r.ok) throw new Error('round');
  const inst = await instanceFor(db, r.round.id);
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });

  const early = await joinWaitlist(db, { roundInstanceId: inst, customerId: cust.id, requestedType: 'child_over_walking' }, ACTIVE);
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.error, 'has_availability');

  // Fill the single seat.
  const filler = await createCustomer(db, { firstName: 'מ', lastName: 'לא', phone: phone() });
  await db.insert(bookings).values({ roundInstanceId: inst, customerId: filler.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: ACTIVE, barcodeToken: `filler-${phone()}` });

  const j1 = await joinWaitlist(db, { roundInstanceId: inst, customerId: cust.id, requestedType: 'child_over_walking' }, ACTIVE);
  assert.equal(j1.ok, true);
  if (j1.ok) {
    assert.equal(j1.position, 1);
    assert.equal(j1.alreadyOnList, false);
  }
  const j2 = await joinWaitlist(db, { roundInstanceId: inst, customerId: cust.id, requestedType: 'child_over_walking' }, ACTIVE);
  assert.equal(j2.ok && j2.alreadyOnList, true);
});

test('promoteWaitlist offers a freed seat to the FIFO first waiter and notifies', async () => {
  const db = await freshDb();
  const { inst, fillerBookingId } = await fullRound(db);
  const c1 = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });
  const c2 = await createCustomer(db, { firstName: 'ה', lastName: 'ו', phone: phone() });
  await joinWaitlist(db, { roundInstanceId: inst, customerId: c1.id, requestedType: 'child_over_walking' }, ACTIVE);
  await joinWaitlist(db, { roundInstanceId: inst, customerId: c2.id, requestedType: 'child_over_walking' }, ACTIVE_LATER);

  await freeSeat(db, fillerBookingId);
  const res = await promoteWaitlist(db, inst, ACTIVE_PROMOTE);
  assert.ok(res.promoted);
  if (res.promoted) {
    assert.equal(res.promoted.customerId, c1.id); // FIFO — the earlier joiner
    assert.ok(res.promoted.claimExpiresAt.getTime() > ACTIVE_PROMOTE.getTime());
  }
  const e1 = (await db.select().from(waitlistEntries).where(eq(waitlistEntries.customerId, c1.id)).limit(1))[0];
  assert.equal(e1!.status, 'notified');
  assert.ok(e1!.claimExpiresAt !== null);
  const e2 = (await db.select().from(waitlistEntries).where(eq(waitlistEntries.customerId, c2.id)).limit(1))[0];
  assert.equal(e2!.status, 'waiting'); // still second in line
});

test('promoteWaitlist offers nothing while the round is still full', async () => {
  const db = await freshDb();
  const { inst } = await fullRound(db);
  const c1 = await createCustomer(db, { firstName: 'ז', lastName: 'ח', phone: phone() });
  await joinWaitlist(db, { roundInstanceId: inst, customerId: c1.id, requestedType: 'child_over_walking' }, ACTIVE);
  const res = await promoteWaitlist(db, inst, ACTIVE_PROMOTE);
  assert.equal(res.promoted, null);
  if (!res.promoted) assert.equal(res.reason, 'no_room');
});

test('promoteWaitlist defers in quiet hours, leaving the entry waiting', async () => {
  const db = await freshDb();
  const { inst, fillerBookingId } = await fullRound(db);
  const c1 = await createCustomer(db, { firstName: 'ט', lastName: 'י', phone: phone() });
  await joinWaitlist(db, { roundInstanceId: inst, customerId: c1.id, requestedType: 'child_over_walking' }, ACTIVE);
  await freeSeat(db, fillerBookingId);
  const res = await promoteWaitlist(db, inst, QUIET);
  assert.equal(res.promoted, null);
  if (!res.promoted) assert.equal(res.reason, 'quiet_hours');
  const e = (await db.select().from(waitlistEntries).where(eq(waitlistEntries.customerId, c1.id)).limit(1))[0];
  assert.equal(e!.status, 'waiting');
});

test('expireWaitlistClaims expires a lapsed offer and reports the round', async () => {
  const db = await freshDb();
  const { inst, fillerBookingId } = await fullRound(db);
  const c1 = await createCustomer(db, { firstName: 'כ', lastName: 'ל', phone: phone() });
  await joinWaitlist(db, { roundInstanceId: inst, customerId: c1.id, requestedType: 'child_over_walking' }, ACTIVE);
  await freeSeat(db, fillerBookingId);
  const p = await promoteWaitlist(db, inst, new Date('2026-07-01T10:00:00Z'));
  assert.ok(p.promoted);

  const later = new Date('2026-07-01T11:01:00Z'); // > 60-min claim window
  const affected = await expireWaitlistClaims(db, later);
  assert.deepEqual(affected, [inst]);
  const e = (await db.select().from(waitlistEntries).where(eq(waitlistEntries.customerId, c1.id)).limit(1))[0];
  assert.equal(e!.status, 'expired');
});

test('markWaitlistClaimed closes an active offer', async () => {
  const db = await freshDb();
  const { inst } = await fullRound(db);
  const c1 = await createCustomer(db, { firstName: 'מ', lastName: 'נ', phone: phone() });
  await joinWaitlist(db, { roundInstanceId: inst, customerId: c1.id, requestedType: 'child_over_walking' }, ACTIVE);
  await markWaitlistClaimed(db, inst, c1.id, ACTIVE);
  const e = (await db.select().from(waitlistEntries).where(eq(waitlistEntries.customerId, c1.id)).limit(1))[0];
  assert.equal(e!.status, 'claimed');
});

test('leaveWaitlist is owner-gated', async () => {
  const db = await freshDb();
  const { inst } = await fullRound(db);
  const c1 = await createCustomer(db, { firstName: 'ס', lastName: 'ע', phone: phone() });
  const other = await createCustomer(db, { firstName: 'פ', lastName: 'צ', phone: phone() });
  const j = await joinWaitlist(db, { roundInstanceId: inst, customerId: c1.id, requestedType: 'child_over_walking' }, ACTIVE);
  assert.ok(j.ok);
  if (!j.ok) return;
  const forbidden = await leaveWaitlist(db, j.entryId, other.id, ACTIVE);
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error, 'forbidden');
  const ok = await leaveWaitlist(db, j.entryId, c1.id, ACTIVE);
  assert.equal(ok.ok, true);
});
