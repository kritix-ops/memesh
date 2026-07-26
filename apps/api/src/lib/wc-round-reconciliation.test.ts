// @memesh/db's package entry constructs a pg pool from DATABASE_URL at import
// time, so set it before importing (the pool is lazy; tests use a PGlite db).
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import type { KeyResolver } from '@memesh/qr-engine';

const { createCustomer, createRound, createHold, bookings, roundInstances } = await import(
  '@memesh/db'
);
const { reconcileRoundBookings } = await import('./wc-round-reconciliation.js');

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

const SECRET = 'a-booking-secret-at-least-32-chars!!';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (keyId) => (keyId === '1' ? SECRET : undefined),
};

const NOW = new Date('2026-07-01T10:00:00.000Z');
const TODAY = '2026-07-01';
let phoneSeq = 300;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder });
  return db;
}

// Seed a round instance + one held booking; return the hold id (which the fake
// WC order carries as its line-item `_memesh_hold_id`).
async function seedHold(db: Awaited<ReturnType<typeof freshDb>>, capacity = 5) {
  const r = await createRound(
    db,
    {
      label: 'a',
      displayName: 'סבב',
      startTime: '16:00',
      endTime: '18:00',
      daysActive: 127,
      defaultCapacity: capacity,
    },
    NOW,
  );
  if (!r.ok) throw new Error('round');
  const inst = (
    await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, r.round.id), eq(roundInstances.date, TODAY)))
      .limit(1)
  )[0];
  if (!inst) throw new Error('instance');
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  const hold = await createHold(
    db,
    { roundInstanceId: inst.id, customerId: cust.id, ticketType: 'child_over_walking' },
    NOW,
  );
  if (!hold.ok) throw new Error('hold');
  return hold.holdId;
}

// A WC order the way the REST API returns it: `processing` by default (paid but
// not operator-completed), one ticket line carrying the hold id + charged total.
function fakeRoundOrder(
  id: number,
  holdId: string,
  over: { status?: string; total?: string } = {},
): unknown {
  return {
    id,
    status: over.status ?? 'processing',
    line_items: [
      {
        id: id * 10,
        product_id: 300,
        total: over.total ?? '55.00',
        total_tax: '0.00',
        meta_data: [{ key: '_memesh_hold_id', value: holdId }],
      },
    ],
    meta_data: [],
  };
}

const fetcher = (orders: unknown[]) => async () => orders;

// ---------------------------------------------------------------------------

test('reconcileRoundBookings mints a paid hold the live webhook missed', async () => {
  const db = await freshDb();
  const holdId = await seedHold(db);

  const result = await reconcileRoundBookings(
    db,
    { listPaidOrdersSince: fetcher([fakeRoundOrder(5001, holdId)]), resolver },
    { lookbackHours: 48, now: NOW },
  );

  assert.equal(result.ordersScanned, 1);
  assert.equal(result.bookingsMinted, 1);
  assert.equal(result.orphanedPaidSeats, 0);

  const row = (await db.select().from(bookings).where(eq(bookings.id, holdId)).limit(1))[0];
  assert.equal(row!.status, 'confirmed');
  assert.equal(row!.wcOrderId, '5001');
  assert.equal(row!.paidTicketIls, 55); // snapshotted from the line total
});

test('reconcileRoundBookings heals a `processing` order (not just completed)', async () => {
  const db = await freshDb();
  const holdId = await seedHold(db);

  const result = await reconcileRoundBookings(
    db,
    {
      listPaidOrdersSince: fetcher([fakeRoundOrder(5002, holdId, { status: 'processing' })]),
      resolver,
    },
    { lookbackHours: 48, now: NOW },
  );
  assert.equal(result.bookingsMinted, 1);

  const row = (await db.select().from(bookings).where(eq(bookings.id, holdId)).limit(1))[0];
  assert.equal(row!.status, 'confirmed');
});

test('reconcileRoundBookings is idempotent on repeated runs', async () => {
  const db = await freshDb();
  const holdId = await seedHold(db);
  const orders = [fakeRoundOrder(5003, holdId)];

  await reconcileRoundBookings(
    db,
    { listPaidOrdersSince: fetcher(orders), resolver },
    { lookbackHours: 48, now: NOW },
  );
  // Second run: mintBooking replays the already-confirmed booking — no new row,
  // no state change.
  await reconcileRoundBookings(
    db,
    { listPaidOrdersSince: fetcher(orders), resolver },
    { lookbackHours: 48, now: NOW },
  );

  const rows = await db.select().from(bookings).where(eq(bookings.id, holdId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'confirmed');
});

test('reconcileRoundBookings counts an orphaned paid seat (hold not found)', async () => {
  const db = await freshDb();
  // Well-formed uuid that does not exist → mintBooking returns not_found →
  // a genuine orphaned paid seat.
  const ghost = '00000000-0000-0000-0000-000000000000';

  const result = await reconcileRoundBookings(
    db,
    { listPaidOrdersSince: fetcher([fakeRoundOrder(5004, ghost)]), resolver },
    { lookbackHours: 48, now: NOW },
  );
  assert.equal(result.ordersScanned, 1);
  assert.equal(result.bookingsMinted, 0);
  assert.equal(result.orphanedPaidSeats, 1);
});

test('reconcileRoundBookings uses lookbackHours to compute the WC `since` cutoff', async () => {
  const db = await freshDb();
  let capturedSince: Date | undefined;
  await reconcileRoundBookings(
    db,
    {
      listPaidOrdersSince: async (since) => {
        capturedSince = since;
        return [];
      },
      resolver,
    },
    { lookbackHours: 6, now: new Date('2026-06-20T12:00:00.000Z') },
  );
  assert.ok(capturedSince);
  assert.equal(capturedSince!.toISOString(), '2026-06-20T06:00:00.000Z');
});

test('reconcileRoundBookings returns a clean zero result when WC has no paid orders', async () => {
  const db = await freshDb();
  const result = await reconcileRoundBookings(
    db,
    { listPaidOrdersSince: fetcher([]), resolver },
    { lookbackHours: 48, now: NOW },
  );
  assert.deepEqual(result, {
    ordersScanned: 0,
    bookingsMinted: 0,
    companionUpgrades: 0,
    orphanedPaidSeats: 0,
    lookbackHours: 48,
  });
});

test('reconcileRoundBookings propagates errors from the fetcher (so the cron route 5xxs)', async () => {
  const db = await freshDb();
  await assert.rejects(
    () =>
      reconcileRoundBookings(
        db,
        {
          listPaidOrdersSince: async () => {
            throw new Error('[wc-rest] round-recon orders fetch failed: 401 Sorry');
          },
          resolver,
        },
        { lookbackHours: 48, now: NOW },
      ),
    /401 Sorry/,
  );
});
