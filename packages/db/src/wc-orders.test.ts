import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { createCustomer, createPunchCard } from './cards';
import {
  countCardsForWcOrder,
  getWcProductCardConfig,
  markWcWebhookProcessed,
  recordWcWebhookFailure,
  resolveOrCreateCustomerFromWc,
  seedWcProductCardConfigs,
  WC_PRODUCT_CARD_CONFIG_SEEDS,
} from './wc-orders';
import {
  customers,
  wcProcessedWebhooks,
  wcProductCardConfigs,
  wcWebhookFailures,
} from './schema/index';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const TEST_SECRET = 'test-secret-that-is-at-least-32-characters';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: 'test-key', secret: TEST_SECRET }),
  resolveVerifyKey: (keyId) => (keyId === 'test-key' ? TEST_SECRET : undefined),
};

let seq = 0;
async function makePhone() {
  seq += 1;
  return `052-000-${String(seq).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// seedWcProductCardConfigs + getWcProductCardConfig
// ---------------------------------------------------------------------------

test('seedWcProductCardConfigs inserts the SKU 1004 row with forever validity', async () => {
  const db = await freshDb();
  const result = await seedWcProductCardConfigs(db, WC_PRODUCT_CARD_CONFIG_SEEDS);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 0);

  const config = await getWcProductCardConfig(db, '1004');
  assert.ok(config);
  assert.equal(config.wcSku, '1004');
  assert.equal(config.totalEntries, 12);
  assert.equal(config.validityDays, null);
  assert.equal(config.isActive, true);
});

test('seedWcProductCardConfigs is idempotent on the second run', async () => {
  const db = await freshDb();
  await seedWcProductCardConfigs(db, WC_PRODUCT_CARD_CONFIG_SEEDS);
  const second = await seedWcProductCardConfigs(db, WC_PRODUCT_CARD_CONFIG_SEEDS);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 1);

  // Only one row exists.
  const rows = await db.select().from(wcProductCardConfigs);
  assert.equal(rows.length, 1);
});

test('seedWcProductCardConfigs does not overwrite an existing row with different values', async () => {
  const db = await freshDb();
  // Operator manually changed the row (e.g. via admin SQL) to 24 entries.
  await db.insert(wcProductCardConfigs).values({
    wcSku: '1004',
    totalEntries: 24,
    validityDays: 90,
  });
  await seedWcProductCardConfigs(db, WC_PRODUCT_CARD_CONFIG_SEEDS);

  const config = await getWcProductCardConfig(db, '1004');
  assert.ok(config);
  assert.equal(config.totalEntries, 24); // operator's value preserved
  assert.equal(config.validityDays, 90);
});

test('getWcProductCardConfig returns undefined for an unknown SKU', async () => {
  const db = await freshDb();
  await seedWcProductCardConfigs(db, WC_PRODUCT_CARD_CONFIG_SEEDS);
  const config = await getWcProductCardConfig(db, '9999');
  assert.equal(config, undefined);
});

test('getWcProductCardConfig skips inactive rows', async () => {
  const db = await freshDb();
  await db.insert(wcProductCardConfigs).values({
    wcSku: '2002',
    totalEntries: 6,
    validityDays: 30,
    isActive: false,
  });
  const config = await getWcProductCardConfig(db, '2002');
  assert.equal(config, undefined);
});

// ---------------------------------------------------------------------------
// markWcWebhookProcessed (idempotency primitive)
// ---------------------------------------------------------------------------

test('markWcWebhookProcessed inserts on first delivery and records the row', async () => {
  const db = await freshDb();
  const result = await markWcWebhookProcessed(db, {
    deliveryId: 'wc-delivery-1',
    wcOrderId: '500',
    topic: 'order.updated',
  });
  assert.equal(result.inserted, true);

  const rows = await db
    .select()
    .from(wcProcessedWebhooks)
    .where(eq(wcProcessedWebhooks.deliveryId, 'wc-delivery-1'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.wcOrderId, '500');
  assert.equal(rows[0]?.topic, 'order.updated');
});

test('markWcWebhookProcessed returns inserted=false on a duplicate delivery id', async () => {
  const db = await freshDb();
  await markWcWebhookProcessed(db, {
    deliveryId: 'wc-delivery-1',
    wcOrderId: '500',
    topic: 'order.updated',
  });
  const second = await markWcWebhookProcessed(db, {
    deliveryId: 'wc-delivery-1',
    wcOrderId: '500',
    topic: 'order.updated',
  });
  assert.equal(second.inserted, false);

  // Still only one row.
  const rows = await db.select().from(wcProcessedWebhooks);
  assert.equal(rows.length, 1);
});

test('markWcWebhookProcessed treats different delivery ids for the same order as distinct', async () => {
  const db = await freshDb();
  const a = await markWcWebhookProcessed(db, {
    deliveryId: 'wc-delivery-A',
    wcOrderId: '500',
    topic: 'order.updated',
  });
  const b = await markWcWebhookProcessed(db, {
    deliveryId: 'wc-delivery-B',
    wcOrderId: '500',
    topic: 'order.updated',
  });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, true);
});

// ---------------------------------------------------------------------------
// countCardsForWcOrder
// ---------------------------------------------------------------------------

test('countCardsForWcOrder returns 0 when no card has that wcOrderId', async () => {
  const db = await freshDb();
  const count = await countCardsForWcOrder(db, '999');
  assert.equal(count, 0);
});

test('countCardsForWcOrder counts cards tagged with the same WC order id', async () => {
  const db = await freshDb();
  const phone = await makePhone();
  const cust = await createCustomer(db, { firstName: 'Noa', lastName: 'Cohen', phone });

  await createPunchCard(db, resolver, { customerId: cust.id, wcOrderId: '500' });
  await createPunchCard(db, resolver, { customerId: cust.id, wcOrderId: '500' });
  await createPunchCard(db, resolver, { customerId: cust.id, wcOrderId: '501' });
  await createPunchCard(db, resolver, { customerId: cust.id }); // wcOrderId null

  assert.equal(await countCardsForWcOrder(db, '500'), 2);
  assert.equal(await countCardsForWcOrder(db, '501'), 1);
  assert.equal(await countCardsForWcOrder(db, '502'), 0);
});

// ---------------------------------------------------------------------------
// recordWcWebhookFailure
// ---------------------------------------------------------------------------

test('recordWcWebhookFailure stores the reason and the raw payload for review', async () => {
  const db = await freshDb();
  const row = await recordWcWebhookFailure(db, {
    deliveryId: 'wc-delivery-77',
    wcOrderId: '777',
    reason: 'phone_missing',
    payload: { id: 777, billing: { first_name: 'Tamar', phone: '' } },
  });

  assert.equal(row.deliveryId, 'wc-delivery-77');
  assert.equal(row.wcOrderId, '777');
  assert.equal(row.reason, 'phone_missing');
  assert.equal(row.resolvedAt, null);
  assert.equal(row.resolvedBy, null);
  const payload = row.payload as { id: number; billing: { first_name: string; phone: string } };
  assert.equal(payload.id, 777);
  assert.equal(payload.billing.first_name, 'Tamar');
});

test('recordWcWebhookFailure accepts null delivery and order ids (e.g. malformed payload)', async () => {
  const db = await freshDb();
  const row = await recordWcWebhookFailure(db, {
    deliveryId: null,
    wcOrderId: null,
    reason: 'validation_failure',
    payload: { error: 'body was not valid json' },
  });
  assert.equal(row.deliveryId, null);
  assert.equal(row.wcOrderId, null);
  assert.equal(row.reason, 'validation_failure');

  const rows = await db.select().from(wcWebhookFailures);
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------------------
// resolveOrCreateCustomerFromWc
// ---------------------------------------------------------------------------

test('resolveOrCreateCustomerFromWc creates a new customer when none exists', async () => {
  const db = await freshDb();
  const phone = await makePhone();
  const result = await resolveOrCreateCustomerFromWc(db, {
    phone,
    firstName: 'Tamar',
    lastName: 'Levi',
    email: 'tamar@example.com',
    wpUserId: null,
    marketingConsent: false,
  });

  assert.equal(result.created, true);
  assert.equal(result.customer.firstName, 'Tamar');
  assert.equal(result.customer.lastName, 'Levi');
  assert.equal(result.customer.phone, phone);
  assert.equal(result.customer.email, 'tamar@example.com');
  assert.equal(result.customer.source, 'website');
  assert.equal(result.customer.wpUserId, null);
  assert.equal(result.customer.marketingConsentAt, null);
});

test('resolveOrCreateCustomerFromWc returns the existing customer (does not double-create)', async () => {
  const db = await freshDb();
  const phone = await makePhone();
  const first = await resolveOrCreateCustomerFromWc(db, {
    phone,
    firstName: 'Noa',
    lastName: 'Cohen',
    email: null,
    wpUserId: null,
    marketingConsent: false,
  });
  const second = await resolveOrCreateCustomerFromWc(db, {
    phone,
    firstName: 'Different',
    lastName: 'Name',
    email: 'changed@example.com',
    wpUserId: null,
    marketingConsent: true,
  });

  assert.equal(second.created, false);
  assert.equal(second.customer.id, first.customer.id);
  // Existing fields are preserved; we never overwrite a returning customer.
  assert.equal(second.customer.firstName, 'Noa');
  assert.equal(second.customer.lastName, 'Cohen');

  const allCustomers = await db.select().from(customers);
  assert.equal(allCustomers.length, 1);
});

test('resolveOrCreateCustomerFromWc records marketingConsentAt when consent is given', async () => {
  const db = await freshDb();
  const phone = await makePhone();
  const fixedNow = new Date('2026-06-20T12:00:00.000Z');
  const result = await resolveOrCreateCustomerFromWc(db, {
    phone,
    firstName: 'Tamar',
    lastName: 'Levi',
    email: null,
    wpUserId: null,
    marketingConsent: true,
    now: fixedNow,
  });
  assert.deepEqual(result.customer.marketingConsentAt, fixedNow);
});

test('resolveOrCreateCustomerFromWc stores wpUserId from WC billing.customer_id', async () => {
  const db = await freshDb();
  const phone = await makePhone();
  const result = await resolveOrCreateCustomerFromWc(db, {
    phone,
    firstName: 'Tamar',
    lastName: 'Levi',
    email: null,
    wpUserId: 4242,
    marketingConsent: false,
  });
  assert.equal(result.created, true);
  assert.equal(result.customer.wpUserId, 4242);

  // Persisted, not just stitched in the return value.
  const rows = await db.select().from(customers).where(eq(customers.phone, phone));
  assert.equal(rows[0]?.wpUserId, 4242);
});

test('resolveOrCreateCustomerFromWc backfills wpUserId on an existing customer that had none', async () => {
  const db = await freshDb();
  const phone = await makePhone();
  // Customer was created at the counter earlier with no WP user.
  await createCustomer(db, { firstName: 'Noa', lastName: 'Cohen', phone });

  const result = await resolveOrCreateCustomerFromWc(db, {
    phone,
    firstName: 'Noa',
    lastName: 'Cohen',
    email: null,
    wpUserId: 7777,
    marketingConsent: false,
  });
  assert.equal(result.created, false);
  assert.equal(result.customer.wpUserId, 7777);

  // Persisted on the existing row.
  const rows = await db.select().from(customers).where(eq(customers.phone, phone));
  assert.equal(rows[0]?.wpUserId, 7777);
});

test('resolveOrCreateCustomerFromWc does NOT overwrite an existing wpUserId', async () => {
  const db = await freshDb();
  const phone = await makePhone();
  // Customer already linked to WP user 1111.
  await resolveOrCreateCustomerFromWc(db, {
    phone,
    firstName: 'Noa',
    lastName: 'Cohen',
    email: null,
    wpUserId: 1111,
    marketingConsent: false,
  });

  // A later purchase reports a different wp user id — leave existing one alone.
  const result = await resolveOrCreateCustomerFromWc(db, {
    phone,
    firstName: 'Noa',
    lastName: 'Cohen',
    email: null,
    wpUserId: 2222,
    marketingConsent: false,
  });
  assert.equal(result.created, false);
  assert.equal(result.customer.wpUserId, 1111);
});
