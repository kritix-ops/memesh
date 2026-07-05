// Multi-day availability composition for the day-strip picker (plan
// 2026-07-05-rounds-day-strip): date sequence, schedule-rule filtering and
// outside behavior, master switch, and booking-driven seat counts — mirroring
// the single-date route contract day by day.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { updateRoundSettings } from './round-settings';
import { roundAvailabilityRange } from './rounds-availability-range';
import { createScheduleRule } from './rounds-schedule';
import { createRound } from './rounds';
import { bookings, roundInstances } from './schema';
import { and, eq } from 'drizzle-orm';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const NOW = new Date(2026, 6, 1, 12, 0, 0);
const FROM = '2026-07-10'; // a Friday
let phoneSeq = 950;
const phone = () => `05000000${(phoneSeq += 1)}`;

/** A daily 16:00–18:00 round with capacity `cap`, instances materialized from NOW. */
async function dailyRound(db: Awaited<ReturnType<typeof freshDb>>, cap = 5) {
  const r = await createRound(
    db,
    { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: cap },
    NOW,
  );
  if (!r.ok) throw new Error('round');
  return r.round;
}

test('range: one entry per day in sequence, default all-rounds mandatory', async () => {
  const db = await freshDb();
  await dailyRound(db);
  const range = await roundAvailabilityRange(db, FROM, 3, NOW);
  assert.equal(range.length, 3);
  assert.deepEqual(
    range.map((d) => d.date),
    ['2026-07-10', '2026-07-11', '2026-07-12'],
  );
  for (const day of range) {
    assert.equal(day.roundsRequired, true);
    assert.equal(day.rounds.length, 1);
    assert.equal(day.rounds[0]!.available, 5);
  }
});

test('range: bookings reduce a single day without touching its neighbors', async () => {
  const db = await freshDb();
  const round = await dailyRound(db, 2);
  const inst = (
    await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, round.id), eq(roundInstances.date, FROM)))
      .limit(1)
  )[0];
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  await db.insert(bookings).values({
    roundInstanceId: inst!.id,
    customerId: cust.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'confirmed',
    confirmedAt: NOW,
    barcodeToken: 'range-filler',
  });

  const range = await roundAvailabilityRange(db, FROM, 2, NOW);
  assert.equal(range[0]!.rounds[0]!.available, 1);
  assert.equal(range[1]!.rounds[0]!.available, 2);
});

test('range: a free_play rule day drops filtered rounds and is not required', async () => {
  const db = await freshDb();
  await dailyRound(db);
  // Windows that the 16:00–18:00 round does NOT fit → nothing offered, and
  // outside=free_play makes the day optional (free play).
  const rule = await createScheduleRule(db, {
    dateFrom: FROM,
    windows: [{ start: '09:00', end: '12:00' }],
    outside: 'free_play',
  });
  assert.equal(rule.ok, true);

  const range = await roundAvailabilityRange(db, FROM, 2, NOW);
  assert.equal(range[0]!.roundsRequired, false);
  assert.equal(range[0]!.rounds.length, 0);
  // The neighbor day has no rule — default mandatory, round offered.
  assert.equal(range[1]!.roundsRequired, true);
  assert.equal(range[1]!.rounds.length, 1);
});

test('range: a closed rule day keeps roundsRequired true with fitting rounds only', async () => {
  const db = await freshDb();
  await dailyRound(db);
  const rule = await createScheduleRule(db, {
    dateFrom: FROM,
    windows: [{ start: '15:00', end: '19:00' }],
    outside: 'closed',
  });
  assert.equal(rule.ok, true);

  const range = await roundAvailabilityRange(db, FROM, 1, NOW);
  assert.equal(range[0]!.roundsRequired, true);
  assert.equal(range[0]!.rounds.length, 1); // 16:00–18:00 fits 15:00–19:00 entirely
});

test('range: an all-day closed rule marks the day closed; plain empty days are not closed', async () => {
  const db = await freshDb();
  await dailyRound(db);
  // No windows + outside closed = the venue is shut that day.
  const rule = await createScheduleRule(db, { dateFrom: FROM, windows: [], outside: 'closed' });
  assert.equal(rule.ok, true);

  const range = await roundAvailabilityRange(db, FROM, 2, NOW);
  assert.equal(range[0]!.closed, true);
  assert.equal(range[0]!.roundsRequired, true);
  assert.equal(range[0]!.rounds.length, 0);
  // The neighbor day has rounds and no rule — open, not closed.
  assert.equal(range[1]!.closed, false);
});

test('range: a free_play empty day is not closed', async () => {
  const db = await freshDb();
  await dailyRound(db);
  const rule = await createScheduleRule(db, { dateFrom: FROM, windows: [], outside: 'free_play' });
  assert.equal(rule.ok, true);
  const range = await roundAvailabilityRange(db, FROM, 1, NOW);
  assert.equal(range[0]!.closed, false);
  assert.equal(range[0]!.roundsRequired, false);
});

test('range: master switch off returns free-play days with no rounds', async () => {
  const db = await freshDb();
  await dailyRound(db);
  await updateRoundSettings(db, { roundsEnabled: false });
  const range = await roundAvailabilityRange(db, FROM, 3, NOW);
  assert.equal(range.length, 3);
  for (const day of range) {
    assert.equal(day.roundsRequired, false);
    assert.equal(day.rounds.length, 0);
  }
});
