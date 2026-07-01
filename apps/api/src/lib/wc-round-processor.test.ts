// @memesh/db constructs a pg pool from DATABASE_URL at import time (lazy; tests
// use a PGlite db), so set it before importing.
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { KeyResolver } from '@memesh/qr-engine';

const { createCustomer, createHold, createRound, bookings, roundInstances } = await import('@memesh/db');
const { processRoundOrderWebhook } = await import('./wc-round-processor.js');

const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url));
const SECRET = 'test-secret-that-is-at-least-32-characters';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: 'k', secret: SECRET }),
  resolveVerifyKey: (id) => (id === 'k' ? SECRET : undefined),
};
const NOW = new Date(2026, 6, 1, 10, 0, 0);
const TODAY = '2026-07-01';
let phoneSeq = 9000;

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder });
  return db;
}

async function seatAndHold(db: Awaited<ReturnType<typeof freshDb>>): Promise<string> {
  const r = await createRound(
    db,
    { label: 'a', displayName: 'סבב', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 5 },
    NOW,
  );
  if (!r.ok) throw new Error('round');
  const inst = (
    await db.select().from(roundInstances).where(and(eq(roundInstances.roundId, r.round.id), eq(roundInstances.date, TODAY))).limit(1)
  )[0];
  if (!inst) throw new Error('instance');
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: `05000${(phoneSeq += 1)}` });
  const hold = await createHold(db, { roundInstanceId: inst.id, customerId: cust.id, ticketType: 'child_over_walking' }, NOW);
  if (!hold.ok) throw new Error('hold');
  return hold.holdId;
}

const order = (over: { id?: number; status?: string; line_items?: unknown[] }) => ({
  id: over.id ?? 555,
  status: over.status ?? 'completed',
  line_items: over.line_items ?? [],
});
const holdItem = (holdId: string) => ({ meta_data: [{ key: '_memesh_hold_id', value: holdId }] });

test('mints a booking from a paid order line item', async () => {
  const db = await freshDb();
  const holdId = await seatAndHold(db);
  const res = await processRoundOrderWebhook(db, {
    topic: 'order.updated',
    payload: order({ line_items: [holdItem(holdId)] }),
    resolver,
    now: NOW,
  });
  assert.equal(res.status, 'processed');
  if (res.status !== 'processed') return;
  assert.equal(res.minted.length, 1);
  assert.equal(res.failed.length, 0);
  const row = (await db.select().from(bookings).where(eq(bookings.id, holdId)).limit(1))[0];
  assert.equal(row!.status, 'confirmed');
  assert.equal(row!.wcOrderId, '555');
  assert.ok(row!.barcodeToken, 'barcode minted');
});

test('idempotent — a second delivery replays the same booking', async () => {
  const db = await freshDb();
  const holdId = await seatAndHold(db);
  const p = order({ line_items: [holdItem(holdId)] });
  const a = await processRoundOrderWebhook(db, { topic: 'order.updated', payload: p, resolver, now: NOW });
  const b = await processRoundOrderWebhook(db, { topic: 'order.updated', payload: p, resolver, now: NOW });
  assert.equal(a.status === 'processed' && b.status === 'processed', true);
  if (a.status !== 'processed' || b.status !== 'processed') return;
  assert.equal(a.minted[0], b.minted[0]);
});

test('ignores wrong topic, non-paid status, and orders with no round items', async () => {
  const db = await freshDb();
  assert.equal((await processRoundOrderWebhook(db, { topic: 'order.deleted', payload: order({}), resolver })).status, 'ignored_topic');
  assert.equal((await processRoundOrderWebhook(db, { topic: 'order.updated', payload: order({ status: 'pending' }), resolver })).status, 'ignored_status');
  assert.equal(
    (await processRoundOrderWebhook(db, { topic: 'order.updated', payload: order({ line_items: [{ meta_data: [] }] }), resolver })).status,
    'no_round_items',
  );
});

test('a malformed hold id is reported as failed, not thrown', async () => {
  const db = await freshDb();
  const res = await processRoundOrderWebhook(db, {
    topic: 'order.updated',
    payload: order({ line_items: [holdItem('not-a-uuid')] }),
    resolver,
    now: NOW,
  });
  assert.equal(res.status, 'processed');
  if (res.status !== 'processed') return;
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0]!.error, 'invalid_hold_id');
});

test('an unparseable payload is rejected', async () => {
  const db = await freshDb();
  const res = await processRoundOrderWebhook(db, { topic: 'order.updated', payload: { nope: true }, resolver });
  assert.equal(res.status, 'invalid_payload');
});
