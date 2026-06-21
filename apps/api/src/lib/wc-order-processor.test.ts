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

const {
  createCustomer,
  customers,
  punchCards,
  seedWcProductCardConfigs,
  WC_PRODUCT_CARD_CONFIG_SEEDS,
  wcProcessedWebhooks,
  wcWebhookFailures,
} = await import('@memesh/db');
const { processWcOrderWebhook } = await import('./wc-order-processor.js');

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

// Minimal WC payload factory. Override per test.
function wcPayload(over: {
  id?: number;
  status?: string;
  customer_id?: number | null;
  billing?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
  line_items?: Array<{
    id?: number;
    sku?: string | null;
    quantity?: number;
    name?: string;
  }>;
} = {}) {
  return {
    id: over.id ?? 500,
    status: over.status ?? 'completed',
    customer_id: over.customer_id ?? 0,
    billing: {
      first_name: over.billing?.first_name ?? 'Tamar',
      last_name: over.billing?.last_name ?? 'Levi',
      email: over.billing?.email ?? 'tamar@example.com',
      phone: over.billing?.phone ?? '052-345-6789',
    },
    line_items: (over.line_items ?? [{ sku: '1004', quantity: 1 }]).map((li, idx) => ({
      id: li.id ?? 1000 + idx,
      sku: li.sku === undefined ? '1004' : li.sku,
      quantity: li.quantity ?? 1,
      name: li.name ?? 'כרטיסייה',
    })),
  };
}

let deliverySeq = 0;
function nextDeliveryId(): string {
  deliverySeq += 1;
  return `wc-delivery-${deliverySeq}`;
}

// ---------------------------------------------------------------------------
// Topic filter
// ---------------------------------------------------------------------------

test('processWcOrderWebhook ignores unrelated topics without DB writes', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'customer.created',
    payload: wcPayload(),
    resolver,
  });
  assert.equal(result.status, 'ignored_topic');

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 0);
  const processed = await db.select().from(wcProcessedWebhooks);
  assert.equal(processed.length, 0);
});

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

test('processWcOrderWebhook records a failure on a malformed payload', async () => {
  const db = await freshDb();
  const deliveryId = nextDeliveryId();
  const result = await processWcOrderWebhook(db, {
    deliveryId,
    topic: 'order.updated',
    payload: { not: 'a real WC order' },
    resolver,
  });
  assert.equal(result.status, 'invalid_payload');

  const failures = await db.select().from(wcWebhookFailures);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.deliveryId, deliveryId);
  assert.equal(failures[0]?.reason, 'invalid_payload');
});

// ---------------------------------------------------------------------------
// Status filter
// ---------------------------------------------------------------------------

test('processWcOrderWebhook ignores orders that are not paid yet (pending, on-hold, etc.)', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ status: 'pending' }),
    resolver,
  });
  assert.equal(result.status, 'ignored_status');

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 0);
});

test('processWcOrderWebhook treats "processing" the same as "completed" (paid; punch cards need no fulfillment)', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ status: 'processing' }),
    resolver,
  });
  assert.equal(result.status, 'processed');

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 1, 'a paid order in processing creates the card');
});

test('processWcOrderWebhook ignores cancelled/refunded orders even after payment', async () => {
  const db = await freshDb();
  for (const status of ['cancelled', 'refunded', 'failed'] as const) {
    const result = await processWcOrderWebhook(db, {
      deliveryId: nextDeliveryId(),
      topic: 'order.updated',
      payload: wcPayload({ status }),
      resolver,
    });
    assert.equal(result.status, 'ignored_status', `status ${status} must be ignored`);
  }
  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 0);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('processWcOrderWebhook creates a customer + card for a fresh order', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ id: 600, billing: { phone: '054-111-2222' } }),
    resolver,
  });
  assert.equal(result.status, 'processed');
  if (result.status !== 'processed') return;
  assert.equal(result.orderId, '600');
  assert.equal(result.customerCreated, true);
  assert.equal(result.cardsCreated.length, 1);

  // Customer row
  const custs = await db.select().from(customers);
  assert.equal(custs.length, 1);
  assert.equal(custs[0]?.firstName, 'Tamar');
  assert.equal(custs[0]?.phone, '0541112222');
  assert.equal(custs[0]?.source, 'website');

  // Card row
  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.wcOrderId, '600');
  assert.equal(cards[0]?.totalEntries, 12);
  assert.equal(cards[0]?.expiresAt, null); // forever per SKU 1004 seed
  assert.equal(cards[0]?.source, 'online');
});

test('processWcOrderWebhook stores wpUserId when WC customer_id is non-zero', async () => {
  const db = await freshDb();
  await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ id: 601, customer_id: 4242, billing: { phone: '054-222-3333' } }),
    resolver,
  });
  const custs = await db.select().from(customers);
  assert.equal(custs[0]?.wpUserId, 4242);
});

test('processWcOrderWebhook leaves wpUserId null for guest checkout (customer_id 0)', async () => {
  const db = await freshDb();
  await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ id: 602, customer_id: 0, billing: { phone: '054-333-4444' } }),
    resolver,
  });
  const custs = await db.select().from(customers);
  assert.equal(custs[0]?.wpUserId, null);
});

test('processWcOrderWebhook reuses an existing customer matched by normalized phone', async () => {
  const db = await freshDb();
  // Production flow stores phones in canonical 05XXXXXXXX form (the API layer
  // runs every write through phoneSchema). Mirror that here so the lookup
  // path matches what happens after a counter registration.
  const existing = await createCustomer(db, {
    firstName: 'Noa',
    lastName: 'Cohen',
    phone: '0545556666',
  });

  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    // Different formatting at the WC end — normalization should still match.
    payload: wcPayload({ id: 700, billing: { phone: '+972-54-555-6666' } }),
    resolver,
  });
  assert.equal(result.status, 'processed');
  if (result.status !== 'processed') return;
  assert.equal(result.customerCreated, false);
  assert.equal(result.customerId, existing.id);

  const allCustomers = await db.select().from(customers);
  assert.equal(allCustomers.length, 1);

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.customerId, existing.id);
  assert.equal(cards[0]?.wcOrderId, '700');
});

test('processWcOrderWebhook creates N cards for a quantity-N line item', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({
      id: 800,
      billing: { phone: '054-777-8888' },
      line_items: [{ sku: '1004', quantity: 3 }],
    }),
    resolver,
  });
  assert.equal(result.status, 'processed');
  if (result.status !== 'processed') return;
  assert.equal(result.cardsCreated.length, 3);

  const cards = await db.select().from(punchCards).where(eq(punchCards.wcOrderId, '800'));
  assert.equal(cards.length, 3);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('processWcOrderWebhook is idempotent on the same delivery id', async () => {
  const db = await freshDb();
  const deliveryId = nextDeliveryId();
  const payload = wcPayload({ id: 900, billing: { phone: '054-999-0000' } });

  const first = await processWcOrderWebhook(db, {
    deliveryId,
    topic: 'order.updated',
    payload,
    resolver,
  });
  assert.equal(first.status, 'processed');

  const second = await processWcOrderWebhook(db, {
    deliveryId,
    topic: 'order.updated',
    payload,
    resolver,
  });
  assert.equal(second.status, 'duplicate');

  // Still only one card created.
  const cards = await db.select().from(punchCards).where(eq(punchCards.wcOrderId, '900'));
  assert.equal(cards.length, 1);
});

test('processWcOrderWebhook is reconciliation-safe: existing cards are not duplicated', async () => {
  const db = await freshDb();
  const payload = wcPayload({
    id: 901,
    billing: { phone: '054-111-9999' },
    line_items: [{ sku: '1004', quantity: 2 }],
  });

  // First delivery creates both cards.
  const first = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload,
    resolver,
  });
  assert.equal(first.status, 'processed');
  if (first.status !== 'processed') return;
  assert.equal(first.cardsCreated.length, 2);

  // Simulate the reconciliation cron processing the same order under a
  // different delivery id (or no delivery id semantically): cards already
  // exist, so the second pass creates 0.
  const second = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload,
    resolver,
  });
  assert.equal(second.status, 'processed');
  if (second.status !== 'processed') return;
  assert.equal(second.cardsCreated.length, 0);

  const cards = await db.select().from(punchCards).where(eq(punchCards.wcOrderId, '901'));
  assert.equal(cards.length, 2);
});

// ---------------------------------------------------------------------------
// SKU filter
// ---------------------------------------------------------------------------

test('processWcOrderWebhook returns no_matching_skus when no line item matches', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({
      id: 1100,
      billing: { phone: '054-100-2000' },
      line_items: [{ sku: '9999', quantity: 1 }],
    }),
    resolver,
  });
  assert.equal(result.status, 'no_matching_skus');

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 0);
  // Customer is NOT created when the order has nothing actionable.
  const custs = await db.select().from(customers);
  assert.equal(custs.length, 0);
});

test('processWcOrderWebhook skips unknown SKUs but creates cards for matching ones', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({
      id: 1101,
      billing: { phone: '054-100-3000' },
      line_items: [
        { sku: '9999', quantity: 2 },
        { sku: '1004', quantity: 1 },
      ],
    }),
    resolver,
  });
  assert.equal(result.status, 'processed');
  if (result.status !== 'processed') return;
  assert.equal(result.cardsCreated.length, 1);
});

test('processWcOrderWebhook skips line items with null SKUs', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({
      id: 1102,
      billing: { phone: '054-100-4000' },
      line_items: [
        { sku: null, quantity: 1 },
        { sku: '1004', quantity: 1 },
      ],
    }),
    resolver,
  });
  assert.equal(result.status, 'processed');
  if (result.status !== 'processed') return;
  assert.equal(result.cardsCreated.length, 1);
});

// ---------------------------------------------------------------------------
// Phone validation failure
// ---------------------------------------------------------------------------

test('processWcOrderWebhook records a failure when billing phone is empty', async () => {
  const db = await freshDb();
  const deliveryId = nextDeliveryId();
  const result = await processWcOrderWebhook(db, {
    deliveryId,
    topic: 'order.updated',
    payload: wcPayload({ id: 1200, billing: { phone: '' } }),
    resolver,
  });
  assert.equal(result.status, 'failure');
  if (result.status !== 'failure') return;
  assert.equal(result.reason, 'phone_missing');

  // No customer, no card, but a failure row exists.
  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 0);
  const custs = await db.select().from(customers);
  assert.equal(custs.length, 0);
  const failures = await db.select().from(wcWebhookFailures);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, 'phone_missing');
  assert.equal(failures[0]?.wcOrderId, '1200');
  assert.equal(failures[0]?.deliveryId, deliveryId);
});

test('processWcOrderWebhook records a failure for a phone that cannot be normalized', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ id: 1201, billing: { phone: 'not-a-number' } }),
    resolver,
  });
  assert.equal(result.status, 'failure');
  if (result.status !== 'failure') return;
  assert.equal(result.reason, 'phone_missing');
});

// ---------------------------------------------------------------------------
// Email-required failure (Yanay 2026-06-20) — web orders MUST have an email
// so the email-OTP fallback works later. WC checkout enforces this by
// default but we defense-in-depth here so a misconfig surfaces as a clean
// failure row instead of a customer with no email on file.
// ---------------------------------------------------------------------------

test('processWcOrderWebhook records a failure when billing email is missing', async () => {
  const db = await freshDb();
  const deliveryId = nextDeliveryId();
  const result = await processWcOrderWebhook(db, {
    deliveryId,
    topic: 'order.updated',
    payload: wcPayload({
      id: 1250,
      // phone is valid; email is omitted — should hit the new email_required gate
      billing: { phone: '054-555-1212', email: '' },
    }),
    resolver,
  });
  assert.equal(result.status, 'failure');
  if (result.status !== 'failure') return;
  assert.equal(result.reason, 'email_required');

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 0);
  const custs = await db.select().from(customers);
  assert.equal(custs.length, 0);
  const failures = await db.select().from(wcWebhookFailures);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, 'email_required');
  assert.equal(failures[0]?.wcOrderId, '1250');
});

test('processWcOrderWebhook accepts an order with a whitespace-only email as email_required', async () => {
  const db = await freshDb();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ id: 1251, billing: { phone: '054-555-9999', email: '   ' } }),
    resolver,
  });
  assert.equal(result.status, 'failure');
  if (result.status !== 'failure') return;
  assert.equal(result.reason, 'email_required');
});

// ---------------------------------------------------------------------------
// Marketing consent
// ---------------------------------------------------------------------------

test('processWcOrderWebhook records marketingConsentAt when consent is passed in', async () => {
  const db = await freshDb();
  const fixedNow = new Date('2026-06-20T12:00:00.000Z');
  await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ id: 1300, billing: { phone: '054-130-1300' } }),
    resolver,
    marketingConsent: true,
    now: fixedNow,
  });
  const custs = await db.select().from(customers);
  assert.deepEqual(custs[0]?.marketingConsentAt, fixedNow);
});

test('processWcOrderWebhook leaves marketingConsentAt null by default', async () => {
  const db = await freshDb();
  await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcPayload({ id: 1301, billing: { phone: '054-130-1301' } }),
    resolver,
  });
  const custs = await db.select().from(customers);
  assert.equal(custs[0]?.marketingConsentAt, null);
});
