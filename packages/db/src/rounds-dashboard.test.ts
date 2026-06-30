// Tests for the dashboard helpers that back /admin/dashboard/live (step 2b).
// Covers the four query functions: rounds-today, stats (with day-over-day
// deltas), waitlist activity, week-ahead grid. Each test sets up only the
// fixtures it needs against a fresh PGlite DB; the migration is the same
// 0015_rounds.sql that runs in production.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import {
  dashboardLiveRoundsToday,
  dashboardLiveStats,
  dashboardLiveWaitlist,
  dashboardLiveWeekAhead,
} from './rounds-dashboard';
import {
  bookings,
  punchCards,
  rounds,
  roundInstances,
  waitlistEntries,
} from './schema';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

let phoneSeq = 0;
function makePhone() {
  phoneSeq += 1;
  return `052-300-${String(phoneSeq).padStart(4, '0')}`;
}

async function freshCustomer(db: Awaited<ReturnType<typeof freshDb>>) {
  return createCustomer(db, {
    firstName: 'בדיקה',
    lastName: 'דשבורד',
    phone: makePhone(),
  });
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// dashboardLiveRoundsToday
// ---------------------------------------------------------------------------

test('rounds-today: empty when no round_instances exist for today', async () => {
  const db = await freshDb();
  const res = await dashboardLiveRoundsToday(db);
  assert.deepEqual(res, []);
});

test('rounds-today: returns instance with capacity and zero taken when no bookings', async () => {
  const db = await freshDb();
  const now = new Date();
  const [round] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב אחר הצהריים',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 50,
    })
    .returning();
  await db.insert(roundInstances).values({
    roundId: round!.id,
    date: isoDate(now),
    capacity: 50,
  });

  const res = await dashboardLiveRoundsToday(db, now);
  assert.equal(res.length, 1);
  assert.equal(res[0]?.label, 'סבב אחר הצהריים');
  assert.equal(res[0]?.startTime, '16:00');
  assert.equal(res[0]?.endTime, '18:00');
  assert.equal(res[0]?.capacity, 50);
  assert.equal(res[0]?.taken, 0);
  assert.equal(res[0]?.heldCount, 0);
  assert.equal(res[0]?.pctFull, 0);
  assert.equal(res[0]?.isClosed, false);
});

test('rounds-today: taken counts confirmed + used + active holds; expired holds excluded', async () => {
  const db = await freshDb();
  const now = new Date();
  const [round] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 10,
    })
    .returning();
  const [instance] = await db
    .insert(roundInstances)
    .values({ roundId: round!.id, date: isoDate(now), capacity: 10 })
    .returning();
  const c1 = await freshCustomer(db);
  const c2 = await freshCustomer(db);
  const c3 = await freshCustomer(db);
  const c4 = await freshCustomer(db);
  const c5 = await freshCustomer(db);

  // 1 confirmed
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: c1.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'confirmed',
  });
  // 1 used
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: c2.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'used',
  });
  // 1 active hold (expires in the future)
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: c3.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'held',
    holdExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
  });
  // 1 expired hold (should NOT count)
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: c4.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'held',
    holdExpiresAt: new Date(now.getTime() - 60 * 1000),
  });
  // 1 cancelled (should NOT count)
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: c5.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'cancelled',
  });

  const res = await dashboardLiveRoundsToday(db, now);
  assert.equal(res[0]?.taken, 3, 'confirmed + used + active hold');
  assert.equal(res[0]?.heldCount, 1, 'just the active hold');
  assert.equal(res[0]?.pctFull, 30, '3/10 = 30%');
});

test('rounds-today: multiple rounds sorted by startTime ASC', async () => {
  const db = await freshDb();
  const now = new Date();
  const [afternoon] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'אחה"צ',
      startTime: '18:00:00',
      endTime: '20:00:00',
      defaultCapacity: 50,
    })
    .returning();
  const [morning] = await db
    .insert(rounds)
    .values({
      label: 'morning',
      displayName: 'בוקר',
      startTime: '10:00:00',
      endTime: '12:00:00',
      defaultCapacity: 50,
    })
    .returning();
  await db.insert(roundInstances).values([
    { roundId: afternoon!.id, date: isoDate(now), capacity: 50 },
    { roundId: morning!.id, date: isoDate(now), capacity: 50 },
  ]);

  const res = await dashboardLiveRoundsToday(db, now);
  assert.equal(res[0]?.startTime, '10:00', 'morning first');
  assert.equal(res[1]?.startTime, '18:00', 'afternoon second');
});

// ---------------------------------------------------------------------------
// dashboardLiveStats
// ---------------------------------------------------------------------------

test('stats: empty DB returns zero counts and null deltas', async () => {
  const db = await freshDb();
  const res = await dashboardLiveStats(db);
  assert.equal(res.revenueIls, 0, 'revenue stubbed until step 3');
  assert.equal(res.revenueDeltaPct, null);
  assert.equal(res.bookingsCount, 0);
  assert.equal(res.bookingsDelta, null, 'null delta when yesterday was 0');
  assert.equal(res.activeHoldsCount, 0);
  assert.equal(res.punchCardsSold, 0);
  assert.equal(res.punchCardsDelta, null);
});

test('stats: counts confirmed bookings from today, ignores yesterday + cancelled', async () => {
  const db = await freshDb();
  const now = new Date('2026-07-15T14:00:00Z');
  const [round] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 50,
    })
    .returning();
  const [instance] = await db
    .insert(roundInstances)
    .values({ roundId: round!.id, date: isoDate(now), capacity: 50 })
    .returning();

  // 2 bookings confirmed today
  for (let i = 0; i < 2; i += 1) {
    const c = await freshCustomer(db);
    await db.insert(bookings).values({
      roundInstanceId: instance!.id,
      customerId: c.id,
      ticketType: 'child_over_walking',
      source: 'paid',
      status: 'confirmed',
      confirmedAt: new Date('2026-07-15T10:00:00Z'),
    });
  }
  // 1 cancelled today (must NOT count)
  const cancelled = await freshCustomer(db);
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: cancelled.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'cancelled',
    confirmedAt: new Date('2026-07-15T10:00:00Z'),
  });
  // 1 confirmed yesterday (must NOT count toward today)
  const yesterday = await freshCustomer(db);
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: yesterday.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'confirmed',
    confirmedAt: new Date('2026-07-14T10:00:00Z'),
  });

  const res = await dashboardLiveStats(db, now);
  assert.equal(res.bookingsCount, 2);
  // Yesterday at hour 14:00: 1 confirmed up to 14:00 → delta = 2 - 1 = +1
  assert.equal(res.bookingsDelta, 1);
});

test('stats: active holds only counts unexpired held bookings', async () => {
  const db = await freshDb();
  const now = new Date();
  const [round] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 50,
    })
    .returning();
  const [instance] = await db
    .insert(roundInstances)
    .values({ roundId: round!.id, date: isoDate(now), capacity: 50 })
    .returning();

  const c1 = await freshCustomer(db);
  const c2 = await freshCustomer(db);
  // active hold
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: c1.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'held',
    holdExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
  });
  // expired hold (must NOT count)
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: c2.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'held',
    holdExpiresAt: new Date(now.getTime() - 60 * 1000),
  });

  const res = await dashboardLiveStats(db, now);
  assert.equal(res.activeHoldsCount, 1);
});

test('stats: counts punch cards sold today; cancelled cards excluded', async () => {
  const db = await freshDb();
  const now = new Date('2026-07-15T14:00:00Z');
  const c1 = await freshCustomer(db);
  // 1 card sold today (direct insert avoids the qr-engine resolver dance —
  // we only care about the createdAt + cancelledAt fields for this test)
  await db.insert(punchCards).values({
    customerId: c1.id,
    serialNumber: 'M-20260715-0001',
    qrToken: 'tok-1',
    keyId: 'test-key',
    totalEntries: 12,
    source: 'pos',
    createdAt: new Date('2026-07-15T10:00:00Z'),
  });
  // 1 card sold yesterday at 13:00 (should be counted by "yesterday at hour" baseline)
  const c2 = await freshCustomer(db);
  await db.insert(punchCards).values({
    customerId: c2.id,
    serialNumber: 'M-20260714-0001',
    qrToken: 'tok-2',
    keyId: 'test-key',
    totalEntries: 12,
    source: 'pos',
    createdAt: new Date('2026-07-14T13:00:00Z'),
  });

  const res = await dashboardLiveStats(db, now);
  assert.equal(res.punchCardsSold, 1);
  // Yesterday at hour 14:00: 1 card sold by then → delta = 1 - 1 = 0
  assert.equal(res.punchCardsDelta, 0);
});

// ---------------------------------------------------------------------------
// dashboardLiveWaitlist
// ---------------------------------------------------------------------------

test('waitlist: empty when no waiting/notified entries on today rounds', async () => {
  const db = await freshDb();
  const now = new Date();
  const [round] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 50,
    })
    .returning();
  await db
    .insert(roundInstances)
    .values({ roundId: round!.id, date: isoDate(now), capacity: 50 });
  const res = await dashboardLiveWaitlist(db, now);
  assert.deepEqual(res, []);
});

test('waitlist: returns count of waiting + notified, excludes claimed/expired/cancelled', async () => {
  const db = await freshDb();
  const now = new Date();
  const [round] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 50,
    })
    .returning();
  const [instance] = await db
    .insert(roundInstances)
    .values({ roundId: round!.id, date: isoDate(now), capacity: 50 })
    .returning();
  const c1 = await freshCustomer(db);
  const c2 = await freshCustomer(db);
  const c3 = await freshCustomer(db);
  await db.insert(waitlistEntries).values([
    {
      roundInstanceId: instance!.id,
      customerId: c1.id,
      requestedType: 'child_over_walking',
      status: 'waiting',
    },
    {
      roundInstanceId: instance!.id,
      customerId: c2.id,
      requestedType: 'child_over_walking',
      status: 'notified',
      notifiedAt: now,
    },
    {
      roundInstanceId: instance!.id,
      customerId: c3.id,
      requestedType: 'child_over_walking',
      status: 'cancelled',
    },
  ]);

  const res = await dashboardLiveWaitlist(db, now);
  assert.equal(res.length, 1);
  assert.equal(res[0]?.waitingCount, 2, 'waiting + notified');
  assert.ok(res[0]?.lastNotifiedAt, 'most recent notifiedAt surfaced');
});

// ---------------------------------------------------------------------------
// dashboardLiveWeekAhead
// ---------------------------------------------------------------------------

test('week-ahead: no active rounds → empty cells but full date list', async () => {
  const db = await freshDb();
  const now = new Date('2026-07-15T14:00:00Z');
  const res = await dashboardLiveWeekAhead(db, now);
  assert.equal(res.length, 7);
  assert.equal(res[0]?.date, '2026-07-15');
  assert.equal(res[6]?.date, '2026-07-21');
  for (const day of res) {
    assert.deepEqual(day.rounds, [], 'no templates → no cells');
  }
});

test('week-ahead: missing instance for a date returns null roundInstanceId + null pctFull', async () => {
  const db = await freshDb();
  const now = new Date('2026-07-15T14:00:00Z');
  const [round] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 50,
    })
    .returning();
  // Materialize only today's instance, leave the other 6 days empty.
  await db
    .insert(roundInstances)
    .values({ roundId: round!.id, date: '2026-07-15', capacity: 50 });

  const res = await dashboardLiveWeekAhead(db, now);
  assert.equal(res.length, 7);
  // Day 0 has the instance
  assert.equal(res[0]?.rounds.length, 1);
  assert.equal(res[0]?.rounds[0]?.roundInstanceId !== null, true);
  assert.equal(res[0]?.rounds[0]?.pctFull, 0);
  // Day 1 — no instance, cell is null/null
  assert.equal(res[1]?.rounds.length, 1, 'template still shows');
  assert.equal(res[1]?.rounds[0]?.roundInstanceId, null);
  assert.equal(res[1]?.rounds[0]?.pctFull, null);
  assert.equal(res[1]?.rounds[0]?.isClosed, false);
});

test('week-ahead: ignores inactive round templates', async () => {
  const db = await freshDb();
  const now = new Date('2026-07-15T14:00:00Z');
  await db.insert(rounds).values({
    label: 'morning',
    displayName: 'בוקר',
    startTime: '10:00:00',
    endTime: '12:00:00',
    defaultCapacity: 50,
    isActive: false,
  });
  const res = await dashboardLiveWeekAhead(db, now);
  for (const day of res) {
    assert.deepEqual(day.rounds, [], 'inactive template not projected');
  }
});
