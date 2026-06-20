// @memesh/db's package entry constructs a pg pool from DATABASE_URL at import
// time, so set it before importing (the pool is lazy; tests use a PGlite db).
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { KeyResolver } from '@memesh/qr-engine';
import type { WcOrderSummary, WcRestClient } from './wc-rest-client.js';

const {
  createCustomer,
  customers,
  punchCards,
  seedWcProductCardConfigs,
  WC_PRODUCT_CARD_CONFIG_SEEDS,
  wcProcessedWebhooks,
} = await import('@memesh/db');
const { processWcOrderWebhook } = await import('./wc-order-processor.js');
const { reconcileWcOrders } = await import('./wc-reconciliation.js');

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

const TEST_SECRET = 'test-secret-that-is-at-least-32-characters';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: 'test-key', secret: TEST_SECRET }),
  resolveVerifyKey: (keyId) => (keyId === 'test-key' ? TEST_SECRET : undefined),
};

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder });
  await seedWcProductCardConfigs(db, WC_PRODUCT_CARD_CONFIG_SEEDS);
  return db;
}

function fakeOrder(over: {
  id: number;
  phone?: string;
  quantity?: number;
  sku?: string | null;
  status?: string;
  customer_id?: number;
}): WcOrderSummary {
  return {
    id: over.id,
    status: over.status ?? 'completed',
    customer_id: over.customer_id ?? 0,
    billing: {
      first_name: 'Test',
      last_name: 'Buyer',
      phone: over.phone ?? `052-000-${String(over.id).padStart(4, '0')}`,
    },
    line_items: [
      {
        id: over.id * 10,
        sku: over.sku === undefined ? '1004' : over.sku,
        quantity: over.quantity ?? 1,
      },
    ],
  };
}

function fakeClient(orders: WcOrderSummary[]): WcRestClient {
  return {
    listCompletedOrdersSince: async () => orders,
  };
}

// ---------------------------------------------------------------------------

test('reconcileWcOrders processes new orders the webhook missed', async () => {
  const db = await freshDb();
  const orders = [fakeOrder({ id: 5001 }), fakeOrder({ id: 5002 })];
  const result = await reconcileWcOrders(
    db,
    { wcClient: fakeClient(orders), resolver },
    { lookbackHours: 48 },
  );

  assert.equal(result.ordersScanned, 2);
  assert.equal(result.cardsHealed, 2);
  assert.equal(result.duplicates, 0);
  assert.equal(result.failures, 0);

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 2);
  const custs = await db.select().from(customers);
  assert.equal(custs.length, 2);
});

test('reconcileWcOrders is a no-op for orders already handled by the live webhook', async () => {
  const db = await freshDb();
  const order = fakeOrder({ id: 6001 });

  // Live webhook handled it first.
  const live = await processWcOrderWebhook(db, {
    deliveryId: 'wc-live-1',
    topic: 'order.updated',
    payload: order,
    resolver,
  });
  assert.equal(live.status, 'processed');

  // Cron runs after the webhook.
  const result = await reconcileWcOrders(
    db,
    { wcClient: fakeClient([order]), resolver },
    { lookbackHours: 48 },
  );

  assert.equal(result.ordersScanned, 1);
  // The order was processed (no duplicate flag) but it created 0 new cards,
  // so cardsHealed is 0.
  assert.equal(result.cardsHealed, 0);

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 1);
});

test('reconcileWcOrders is idempotent on repeated runs (same synthetic delivery id)', async () => {
  const db = await freshDb();
  const order = fakeOrder({ id: 6002 });

  const first = await reconcileWcOrders(
    db,
    { wcClient: fakeClient([order]), resolver },
    { lookbackHours: 48 },
  );
  assert.equal(first.cardsHealed, 1);

  const second = await reconcileWcOrders(
    db,
    { wcClient: fakeClient([order]), resolver },
    { lookbackHours: 48 },
  );
  // Second run: same synthetic id, processor returns 'duplicate', no work.
  assert.equal(second.duplicates, 1);
  assert.equal(second.cardsHealed, 0);

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 1);
  // Only one processed_webhooks row exists for the synthetic id.
  const rows = await db
    .select()
    .from(wcProcessedWebhooks)
    .where(eq(wcProcessedWebhooks.deliveryId, 'recon-6002'));
  assert.equal(rows.length, 1);
});

test('reconcileWcOrders fills the gap when the webhook created some but not all cards', async () => {
  const db = await freshDb();
  // The webhook only created 1 of 3 cards for this order (e.g. crashed
  // mid-loop in an earlier version — simulate by directly writing one card).
  const cust = await createCustomer(db, {
    firstName: 'Existing',
    lastName: 'Buyer',
    phone: '0521234567',
  });
  // Insert one card via the same primitive the processor uses so it has
  // a serial + qrToken.
  const { createPunchCard } = await import('@memesh/db');
  await createPunchCard(db, resolver, {
    customerId: cust.id,
    wcOrderId: '7001',
    source: 'online',
  });

  const order = fakeOrder({ id: 7001, phone: '0521234567', quantity: 3 });
  const result = await reconcileWcOrders(
    db,
    { wcClient: fakeClient([order]), resolver },
    { lookbackHours: 48 },
  );
  assert.equal(result.cardsHealed, 1);

  // Two new cards should have been created so the total matches order quantity.
  const cards = await db
    .select()
    .from(punchCards)
    .where(eq(punchCards.wcOrderId, '7001'));
  assert.equal(cards.length, 3);
});

test('reconcileWcOrders counts ignored orders (unknown SKU)', async () => {
  const db = await freshDb();
  const orders = [
    fakeOrder({ id: 8001, sku: '9999' }), // unknown SKU → no_matching_skus
    fakeOrder({ id: 8002 }), // good
  ];
  const result = await reconcileWcOrders(
    db,
    { wcClient: fakeClient(orders), resolver },
    { lookbackHours: 48 },
  );
  assert.equal(result.ordersScanned, 2);
  assert.equal(result.cardsHealed, 1);
  assert.equal(result.ignored, 1);

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 1);
});

test('reconcileWcOrders counts failures (phone missing) without throwing', async () => {
  const db = await freshDb();
  const orders = [
    fakeOrder({ id: 9001, phone: '' }), // unreachable phone → failure
    fakeOrder({ id: 9002 }), // good
  ];
  const result = await reconcileWcOrders(
    db,
    { wcClient: fakeClient(orders), resolver },
    { lookbackHours: 48 },
  );
  assert.equal(result.ordersScanned, 2);
  assert.equal(result.cardsHealed, 1);
  assert.equal(result.failures, 1);
});

test('reconcileWcOrders uses the lookbackHours to compute the WC `since` cutoff', async () => {
  const db = await freshDb();
  let capturedSince: Date | undefined;
  const client: WcRestClient = {
    listCompletedOrdersSince: async (since) => {
      capturedSince = since;
      return [];
    },
  };

  const now = new Date('2026-06-20T12:00:00.000Z');
  await reconcileWcOrders(db, { wcClient: client, resolver }, { lookbackHours: 6, now });

  assert.ok(capturedSince);
  assert.equal(capturedSince!.toISOString(), '2026-06-20T06:00:00.000Z');
});

test('reconcileWcOrders returns a clean zero result when WC has no completed orders', async () => {
  const db = await freshDb();
  const result = await reconcileWcOrders(
    db,
    { wcClient: fakeClient([]), resolver },
    { lookbackHours: 48 },
  );
  assert.deepEqual(result, {
    ordersScanned: 0,
    cardsHealed: 0,
    duplicates: 0,
    ignored: 0,
    failures: 0,
    lookbackHours: 48,
  });
});

test('reconcileWcOrders propagates errors from the WC client (so the cron route 5xxs)', async () => {
  const db = await freshDb();
  const client: WcRestClient = {
    listCompletedOrdersSince: async () => {
      throw new Error('[wc-rest] orders fetch failed: 401 Sorry');
    },
  };
  await assert.rejects(
    () => reconcileWcOrders(db, { wcClient: client, resolver }, { lookbackHours: 48 }),
    /401 Sorry/,
  );
});
