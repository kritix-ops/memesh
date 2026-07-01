// Rounds admin CRUD + instance materialization. Uses the PGlite fixture like
// rounds.test.ts. Covers validation, create/update, and that materialization
// respects daysActive, stays inside the horizon, is idempotent, and skips
// inactive templates.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import {
  countUpcomingInstances,
  createRound,
  ensureUpcomingInstances,
  listRounds,
  roundAvailabilityForDate,
  updateRound,
  validateRoundInput,
  type RoundInput,
} from './rounds';
import { bookings, roundInstances } from './schema';

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

// A fixed reference date so weekday math is deterministic.
const NOW = new Date(2026, 6, 1, 10, 0, 0); // 2026-07-01, local

async function countInstances(db: Awaited<ReturnType<typeof freshDb>>): Promise<number> {
  const rows = await db.select({ n: count() }).from(roundInstances);
  return Number(rows[0]?.n ?? 0);
}

// --- validation (pure) ------------------------------------------------------

test('validateRoundInput accepts a well-formed input', () => {
  assert.equal(validateRoundInput(baseInput), null);
});

test('validateRoundInput rejects bad times and end<=start', () => {
  assert.deepEqual(validateRoundInput({ ...baseInput, startTime: '25:00' }), {
    code: 'invalid_start_time',
  });
  assert.deepEqual(validateRoundInput({ ...baseInput, endTime: '9:5' }), {
    code: 'invalid_end_time',
  });
  assert.deepEqual(validateRoundInput({ ...baseInput, startTime: '18:00', endTime: '18:00' }), {
    code: 'end_not_after_start',
  });
});

test('validateRoundInput rejects capacity and days out of range', () => {
  assert.equal(validateRoundInput({ ...baseInput, defaultCapacity: 0 })?.code, 'capacity_out_of_range');
  assert.equal(validateRoundInput({ ...baseInput, defaultCapacity: 1.5 })?.code, 'capacity_out_of_range');
  assert.equal(validateRoundInput({ ...baseInput, daysActive: 0 })?.code, 'days_active_out_of_range');
  assert.equal(validateRoundInput({ ...baseInput, daysActive: 128 })?.code, 'days_active_out_of_range');
});

test('validateRoundInput rejects empty/oversized strings', () => {
  assert.deepEqual(validateRoundInput({ ...baseInput, label: '   ' }), { code: 'label_length' });
  assert.deepEqual(validateRoundInput({ ...baseInput, displayName: 'x'.repeat(129) }), {
    code: 'display_name_length',
  });
});

// --- create + materialize ---------------------------------------------------

test('createRound persists the template and materializes instances', async () => {
  const db = await freshDb();
  const res = await createRound(db, baseInput, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.round.displayName, 'סבב אחר הצהריים');
  // Default horizon (30) with daysActive=all → 30 instances.
  assert.equal(await countInstances(db), 30);
});

test('createRound returns a validation error without inserting', async () => {
  const db = await freshDb();
  const res = await createRound(db, { ...baseInput, endTime: '15:00' }, NOW);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, 'end_not_after_start');
  assert.equal(await countInstances(db), 0);
  assert.equal((await listRounds(db)).length, 0);
});

// --- materialization semantics ----------------------------------------------

test('ensureUpcomingInstances respects daysActive and horizon', async () => {
  const db = await freshDb();
  // Sundays only (bit 0). Any 7-day window contains exactly one Sunday.
  const res = await createRound(db, { ...baseInput, daysActive: 1 << 0 }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // createRound already materialized 30 days → ~4-5 Sundays. Re-check a 7-day
  // window directly for a deterministic count of 1.
  const db2 = await freshDb();
  const r2 = await createRound(db2, { ...baseInput, daysActive: 1 << 0, isActive: false }, NOW);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  // Inactive → nothing materialized on create.
  assert.equal(await countInstances(db2), 0);
  // Now activate materialization explicitly over a 7-day window.
  await ensureUpcomingInstances(db2, { ...r2.round, isActive: true }, NOW, 7);
  assert.equal(await countInstances(db2), 1);
});

test('ensureUpcomingInstances is idempotent', async () => {
  const db = await freshDb();
  const res = await createRound(db, baseInput, NOW); // 30 already
  assert.equal(res.ok, true);
  if (!res.ok) return;
  await ensureUpcomingInstances(db, res.round, NOW); // run again
  await ensureUpcomingInstances(db, res.round, NOW); // and again
  assert.equal(await countInstances(db), 30, 'no duplicates on re-run');
});

test('ensureUpcomingInstances skips an inactive round', async () => {
  const db = await freshDb();
  const res = await createRound(db, { ...baseInput, isActive: false }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(await countInstances(db), 0);
});

// --- update -----------------------------------------------------------------

test('updateRound edits fields and reports not-found', async () => {
  const db = await freshDb();
  const created = await createRound(db, baseInput, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = await updateRound(db, created.round.id, { defaultCapacity: 80 }, NOW);
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.round.defaultCapacity, 80);

  const missing = await updateRound(db, '00000000-0000-0000-0000-000000000000', { sortOrder: 1 }, NOW);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal('notFound' in missing && missing.notFound, true);
});

test('updateRound cross-checks end>start against current times', async () => {
  const db = await freshDb();
  const created = await createRound(db, baseInput, NOW); // 16:00–18:00
  assert.equal(created.ok, true);
  if (!created.ok) return;
  // Move start past the existing end → rejected using current.endTime.
  const res = await updateRound(db, created.round.id, { startTime: '19:00' }, NOW);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal('error' in res && res.error.code, 'end_not_after_start');
});

// --- roundAvailabilityForDate ----------------------------------------------

const TODAY_ISO = '2026-07-01'; // matches NOW

async function todayInstanceId(
  db: Awaited<ReturnType<typeof freshDb>>,
  roundId: string,
): Promise<string> {
  const rows = await db
    .select()
    .from(roundInstances)
    .where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, TODAY_ISO)))
    .limit(1);
  const inst = rows[0];
  if (!inst) throw new Error('expected today instance');
  return inst.id;
}

test('roundAvailabilityForDate: capacity minus confirmed + active holds, expired holds ignored', async () => {
  const db = await freshDb();
  const created = await createRound(db, { ...baseInput, defaultCapacity: 10 }, NOW);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const instId = await todayInstanceId(db, created.round.id);
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: '0500000001' });

  await db.insert(bookings).values([
    { roundInstanceId: instId, customerId: cust.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: NOW },
    { roundInstanceId: instId, customerId: cust.id, ticketType: 'child_under_walking', source: 'paid', status: 'held', holdExpiresAt: new Date(NOW.getTime() + 10 * 60_000) },
    { roundInstanceId: instId, customerId: cust.id, ticketType: 'child_over_walking', source: 'paid', status: 'held', holdExpiresAt: new Date(NOW.getTime() - 60_000) },
  ]);

  const avail = await roundAvailabilityForDate(db, TODAY_ISO, NOW);
  const row = avail.find((r) => r.roundInstanceId === instId);
  assert.ok(row, 'round appears in availability');
  assert.equal(row.capacity, 10);
  assert.equal(row.taken, 2, 'confirmed + active held; expired hold not counted');
  assert.equal(row.available, 8);
});

test('roundAvailabilityForDate: excludes inactive rounds and never goes negative', async () => {
  const db = await freshDb();
  const active = await createRound(db, { ...baseInput, defaultCapacity: 2 }, NOW);
  const inactive = await createRound(db, { ...baseInput, label: 'evening', startTime: '18:00', endTime: '20:00', isActive: false }, NOW);
  assert.equal(active.ok && inactive.ok, true);
  if (!active.ok || !inactive.ok) return;

  const instId = await todayInstanceId(db, active.round.id);
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: '0500000002' });
  // Oversell by one to prove available clamps at 0.
  await db.insert(bookings).values([
    { roundInstanceId: instId, customerId: cust.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: NOW },
    { roundInstanceId: instId, customerId: cust.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: NOW },
    { roundInstanceId: instId, customerId: cust.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: NOW },
  ]);

  const avail = await roundAvailabilityForDate(db, TODAY_ISO, NOW);
  assert.equal(avail.length, 1, 'only the active round appears');
  assert.equal(avail[0]!.available, 0, 'clamps at 0, never negative');
});

test('countUpcomingInstances buckets by round', async () => {
  const db = await freshDb();
  const a = await createRound(db, baseInput, NOW);
  const b = await createRound(db, { ...baseInput, label: 'evening', startTime: '18:00', endTime: '20:00' }, NOW);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  const counts = await countUpcomingInstances(db, NOW);
  assert.equal(counts.get(a.round.id), 30);
  assert.equal(counts.get(b.round.id), 30);
});
