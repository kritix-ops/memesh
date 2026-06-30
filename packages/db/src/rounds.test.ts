// Rounds tables (step 2a). Thin shape-pinning tests: the migration applies,
// foreign keys + unique constraints behave as documented, enums accept the
// expected values, and CHECK constraints reject corrupt rows. Real business
// logic (availability calculation, hold expiry, waitlist FIFO) lands in
// step 2b along with the application-layer helpers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import {
  bookings,
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
  return `052-100-${String(phoneSeq).padStart(4, '0')}`;
}

async function freshCustomer(db: Awaited<ReturnType<typeof freshDb>>) {
  return createCustomer(db, {
    firstName: 'בדיקה',
    lastName: 'לקוח',
    phone: makePhone(),
  });
}

async function makeRound(db: Awaited<ReturnType<typeof freshDb>>, overrides: Partial<typeof rounds.$inferInsert> = {}) {
  const [row] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב אחר הצהריים',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 50,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected round row');
  return row;
}

async function makeRoundInstance(
  db: Awaited<ReturnType<typeof freshDb>>,
  roundId: string,
  overrides: Partial<typeof roundInstances.$inferInsert> = {},
) {
  const [row] = await db
    .insert(roundInstances)
    .values({
      roundId,
      date: '2026-07-15',
      capacity: 50,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected round_instance row');
  return row;
}

// ---------------------------------------------------------------------------
// rounds — basics + CHECK constraints
// ---------------------------------------------------------------------------

test('rounds: insert with defaults returns a row with sensible defaults', async () => {
  const db = await freshDb();
  const round = await makeRound(db);
  assert.equal(round.label, 'afternoon');
  assert.equal(round.daysActive, 127, 'default bitmask covers all 7 days');
  assert.equal(round.isActive, true);
  assert.equal(round.sortOrder, 0);
});

test('rounds: rejects negative default_capacity (CHECK)', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => makeRound(db, { defaultCapacity: -1 }),
    /rounds_capacity_nonneg/,
  );
});

test('rounds: rejects days_active outside 0..127 (CHECK)', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => makeRound(db, { daysActive: 128 }),
    /rounds_days_active_range/,
  );
  await assert.rejects(
    () => makeRound(db, { daysActive: -1 }),
    /rounds_days_active_range/,
  );
});

test('rounds: rejects start_time >= end_time (CHECK)', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => makeRound(db, { startTime: '18:00:00', endTime: '16:00:00' }),
    /rounds_time_order/,
  );
  await assert.rejects(
    () => makeRound(db, { startTime: '18:00:00', endTime: '18:00:00' }),
    /rounds_time_order/,
  );
});

// ---------------------------------------------------------------------------
// round_instances — UNIQUE(round_id, date) + foreign key
// ---------------------------------------------------------------------------

test('round_instances: enforces UNIQUE(round_id, date)', async () => {
  const db = await freshDb();
  const round = await makeRound(db);
  await makeRoundInstance(db, round.id, { date: '2026-07-15' });
  await assert.rejects(
    () => makeRoundInstance(db, round.id, { date: '2026-07-15' }),
    /round_instances_round_date_unique|duplicate key/,
  );
});

test('round_instances: same date is allowed across different rounds', async () => {
  const db = await freshDb();
  const r1 = await makeRound(db, { label: 'morning', startTime: '10:00:00', endTime: '12:00:00' });
  const r2 = await makeRound(db);
  await makeRoundInstance(db, r1.id, { date: '2026-07-15' });
  await makeRoundInstance(db, r2.id, { date: '2026-07-15' });
  // No assert needed — both inserts succeeding IS the assertion.
});

test('round_instances: rejects orphan round_id (FK)', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => makeRoundInstance(db, '00000000-0000-0000-0000-000000000000'),
    /foreign key|violates/i,
  );
});

// ---------------------------------------------------------------------------
// bookings — enums, defaults, foreign keys
// ---------------------------------------------------------------------------

test('bookings: insert with required fields succeeds', async () => {
  const db = await freshDb();
  const round = await makeRound(db);
  const instance = await makeRoundInstance(db, round.id);
  const customer = await freshCustomer(db);
  const [row] = await db
    .insert(bookings)
    .values({
      roundInstanceId: instance.id,
      customerId: customer.id,
      ticketType: 'child_over_walking',
      source: 'paid',
      status: 'held',
      holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })
    .returning();
  assert.ok(row);
  assert.equal(row.additionalCompanions, 0, 'default');
  assert.equal(row.status, 'held');
  assert.equal(row.source, 'paid');
});

test('bookings: barcode_token UNIQUE prevents duplicates', async () => {
  const db = await freshDb();
  const round = await makeRound(db);
  const instance = await makeRoundInstance(db, round.id);
  const c1 = await freshCustomer(db);
  const c2 = await freshCustomer(db);
  await db.insert(bookings).values({
    roundInstanceId: instance.id,
    customerId: c1.id,
    ticketType: 'child_over_walking',
    source: 'paid',
    status: 'confirmed',
    barcodeToken: 'shared-token-abc',
  });
  await assert.rejects(
    () =>
      db.insert(bookings).values({
        roundInstanceId: instance.id,
        customerId: c2.id,
        ticketType: 'child_over_walking',
        source: 'paid',
        status: 'confirmed',
        barcodeToken: 'shared-token-abc',
      }),
    /duplicate key|unique/i,
  );
});

test('bookings: rejects negative additional_companions (CHECK)', async () => {
  const db = await freshDb();
  const round = await makeRound(db);
  const instance = await makeRoundInstance(db, round.id);
  const customer = await freshCustomer(db);
  await assert.rejects(
    () =>
      db.insert(bookings).values({
        roundInstanceId: instance.id,
        customerId: customer.id,
        ticketType: 'child_over_walking',
        source: 'paid',
        status: 'held',
        additionalCompanions: -1,
      }),
    /bookings_companions_nonneg/,
  );
});

test('bookings: accepts both ticket_type enum values', async () => {
  const db = await freshDb();
  const round = await makeRound(db);
  const instance = await makeRoundInstance(db, round.id);
  const c1 = await freshCustomer(db);
  const c2 = await freshCustomer(db);
  await db.insert(bookings).values({
    roundInstanceId: instance.id,
    customerId: c1.id,
    ticketType: 'child_under_walking',
    source: 'paid',
    status: 'confirmed',
  });
  await db.insert(bookings).values({
    roundInstanceId: instance.id,
    customerId: c2.id,
    ticketType: 'child_over_walking',
    source: 'punchcard',
    status: 'confirmed',
  });
  const all = await db.select().from(bookings);
  assert.equal(all.length, 2);
});

test('bookings: accepts gift_recipient JSONB payload', async () => {
  const db = await freshDb();
  const round = await makeRound(db);
  const instance = await makeRoundInstance(db, round.id);
  const customer = await freshCustomer(db);
  const recipient = {
    firstName: 'יואב',
    lastName: 'כהן',
    phone: '052-700-7000',
    email: 'yoav@example.com',
  };
  const [row] = await db
    .insert(bookings)
    .values({
      roundInstanceId: instance.id,
      customerId: customer.id,
      ticketType: 'child_over_walking',
      source: 'gift',
      status: 'confirmed',
      giftRecipient: recipient,
    })
    .returning();
  assert.deepEqual(row?.giftRecipient, recipient);
});

// ---------------------------------------------------------------------------
// waitlist_entries — basics
// ---------------------------------------------------------------------------

test('waitlist_entries: insert defaults to waiting status', async () => {
  const db = await freshDb();
  const round = await makeRound(db);
  const instance = await makeRoundInstance(db, round.id);
  const customer = await freshCustomer(db);
  const [row] = await db
    .insert(waitlistEntries)
    .values({
      roundInstanceId: instance.id,
      customerId: customer.id,
      requestedType: 'child_over_walking',
    })
    .returning();
  assert.ok(row);
  assert.equal(row.status, 'waiting');
  assert.equal(row.requestedCompanions, 0);
  assert.equal(row.notifiedAt, null);
});
