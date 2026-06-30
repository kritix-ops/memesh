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
  meta_data?: Array<{ key: string; value: unknown }>;
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
    ...(over.meta_data !== undefined && { meta_data: over.meta_data }),
  };
}

// Convenience helper to build a gift-flavored payload. Defaults to a
// recipient nobody knows ("yuval" + an unused phone) so the pending-claim
// branch fires; tests that exercise direct-mint override the recipient
// fields explicitly.
function wcGiftPayload(over: Parameters<typeof wcPayload>[0] & {
  recipientFirstName?: string;
  recipientLastName?: string;
  recipientPhone?: string;
  recipientEmail?: string;
  giftFlag?: string;
} = {}): ReturnType<typeof wcPayload> {
  const giftMeta: Array<{ key: string; value: unknown }> = [
    { key: '_memesh_gift', value: over.giftFlag ?? 'yes' },
    {
      key: '_memesh_gift_recipient_first_name',
      value: over.recipientFirstName ?? 'יובל',
    },
    {
      key: '_memesh_gift_recipient_last_name',
      value: over.recipientLastName ?? 'נמען',
    },
    {
      key: '_memesh_gift_recipient_phone',
      value: over.recipientPhone ?? '052-999-1111',
    },
    {
      key: '_memesh_gift_recipient_email',
      value: over.recipientEmail ?? 'yuval@example.com',
    },
  ];
  return wcPayload({ ...over, meta_data: [...(over.meta_data ?? []), ...giftMeta] });
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

// ---------------------------------------------------------------------------
// Gift card flow (2026-06-24)
// ---------------------------------------------------------------------------

const {
  findCustomerByPhoneOrEmail: findCustomerByPhoneOrEmailFn,
  findPendingClaimByOrderId,
  giftPendingClaims,
  updateCardSettings: updateCardSettingsFn,
} = await import('@memesh/db');

// The gift flow is shipped behind `giftCardsEnabled` (default off, so the
// feature is dark on production until ops flips it). Every test that
// exercises the gift branch needs to enable it explicitly. The kill-switch
// test at line ~795 deliberately stays on plain freshDb() to prove the
// default-off behavior.
async function freshDbWithGiftCardsEnabled() {
  const db = await freshDb();
  await updateCardSettingsFn(db, { giftCardsEnabled: true });
  return db;
}

test('gift order with unknown recipient creates a pending claim row + no card', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcGiftPayload({
      id: 2000,
      billing: { first_name: 'דנה', last_name: 'בוקובסקי', phone: '052-123-4567', email: 'dana@example.com' },
      recipientFirstName: 'יואב',
      recipientPhone: '052-700-7000',
      recipientEmail: 'yoav-gift@example.com',
    }),
    resolver,
  });

  assert.equal(result.status, 'processed_gift_pending');
  if (result.status === 'processed_gift_pending') {
    assert.equal(result.alreadyExisted, false);
    assert.ok(result.rawClaimToken, 'first delivery returns a raw token');
    assert.equal(result.recipientFirstName, 'יואב');
    assert.equal(result.recipientEmail, 'yoav-gift@example.com');
    assert.equal(result.buyerFirstName, 'דנה');
  }

  const pending = await db.select().from(giftPendingClaims);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.wcOrderId, '2000');
  // Recipient phone is stored in canonical 05XXXXXXXX form (the same shape
  // every customer row uses) so the claim flow's lookup-by-phone matches
  // regardless of how the buyer typed it on the WC form.
  assert.equal(pending[0]?.recipientPhone, '0527007000');

  // No customer or card created on the pending branch.
  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 0);
  // The buyer is not yet a customer either — the gift branch doesn't
  // materialize the buyer until they themselves transact.
  const custs = await db.select().from(customers);
  assert.equal(custs.length, 0);
});

test('gift order with existing recipient (phone match) mints directly with is_gift=true', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  // Customer rows store the canonical 05XXXXXXXX phone form; the processor
  // normalizes the WC-side recipient phone the same way before lookup.
  const recipient = await createCustomer(db, {
    firstName: 'יואב',
    lastName: 'קיים',
    phone: '0528008000',
    email: 'yoav-existing@example.com',
    source: 'website',
  });

  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcGiftPayload({
      id: 2010,
      billing: { first_name: 'דנה', last_name: 'בוקובסקי', phone: '052-200-2000', email: 'dana2@example.com' },
      recipientPhone: '052-800-8000',
      recipientEmail: 'yoav-existing@example.com',
    }),
    resolver,
  });

  assert.equal(result.status, 'processed_gift_direct');
  if (result.status === 'processed_gift_direct') {
    assert.equal(result.recipientCustomerId, recipient.id);
    assert.equal(result.matchedBy, 'phone');
    assert.equal(result.cardsCreated.length, 1);
    assert.equal(result.buyerFirstName, 'דנה');
    assert.equal(result.recipientMatchConflictCustomerId, undefined);
  }

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.customerId, recipient.id);
  assert.equal(cards[0]?.isGift, true);
  assert.equal(cards[0]?.giftBuyerFirstName, 'דנה');
  // Buyer phone is stored in canonical 05XXXXXXXX form so support can
  // trace gift-card origin via the same lookup-by-phone path used elsewhere.
  assert.equal(cards[0]?.giftBuyerPhone, '0522002000');
  assert.ok(cards[0]?.giftClaimedAt, 'direct-mint stamps gift_claimed_at at mint time');

  // No pending claim row when recipient already existed.
  const pending = await db.select().from(giftPendingClaims);
  assert.equal(pending.length, 0);
});

test('gift order with existing recipient (email match) sets matchedBy=email', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  const recipient = await createCustomer(db, {
    firstName: 'יואב',
    lastName: 'מייל',
    phone: '0525555555',
    email: 'email-only-recipient@example.com',
    source: 'website',
  });

  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcGiftPayload({
      id: 2020,
      billing: { phone: '052-201-2010', email: 'dana3@example.com' },
      recipientPhone: '052-444-4444', // unknown phone
      recipientEmail: 'email-only-recipient@example.com',
    }),
    resolver,
  });

  assert.equal(result.status, 'processed_gift_direct');
  if (result.status === 'processed_gift_direct') {
    assert.equal(result.recipientCustomerId, recipient.id);
    assert.equal(result.matchedBy, 'email');
  }
});

test('gift order with phone-vs-email conflict surfaces recipientMatchConflictCustomerId', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  const phoneOwner = await createCustomer(db, {
    firstName: 'בעל',
    lastName: 'טלפון',
    phone: '0526666666',
    email: 'phone-owner@example.com',
    source: 'website',
  });
  const emailOwner = await createCustomer(db, {
    firstName: 'בעל',
    lastName: 'מייל',
    phone: '0527777777',
    email: 'conflict-gift@example.com',
    source: 'website',
  });

  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcGiftPayload({
      id: 2030,
      billing: { phone: '052-301-3010', email: 'dana4@example.com' },
      recipientPhone: '052-666-6666', // matches phoneOwner
      recipientEmail: 'conflict-gift@example.com', // matches emailOwner
    }),
    resolver,
  });

  assert.equal(result.status, 'processed_gift_direct');
  if (result.status === 'processed_gift_direct') {
    assert.equal(result.recipientCustomerId, phoneOwner.id);
    assert.equal(result.matchedBy, 'phone');
    assert.equal(result.recipientMatchConflictCustomerId, emailOwner.id);
  }
});

test('gift order with malformed recipient phone records a failure row', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcGiftPayload({
      id: 2040,
      billing: { phone: '052-401-4010', email: 'dana5@example.com' },
      recipientPhone: 'not-a-phone',
      recipientEmail: 'yoav@example.com',
    }),
    resolver,
  });
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') {
    assert.equal(result.reason, 'gift_recipient_phone_invalid');
  }
  const failures = await db.select().from(wcWebhookFailures);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, 'gift_recipient_phone_invalid');
});

test('gift order with missing recipient email records a failure row', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcGiftPayload({
      id: 2050,
      billing: { phone: '052-501-5010', email: 'dana6@example.com' },
      recipientPhone: '052-900-9000',
      recipientEmail: '',
    }),
    resolver,
  });
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') {
    assert.equal(result.reason, 'gift_recipient_email_missing');
  }
});

test('gift order with missing recipient first name records a failure row', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcGiftPayload({
      id: 2055,
      billing: { phone: '052-551-5510', email: 'dana7@example.com' },
      recipientFirstName: '',
      recipientPhone: '052-901-9010',
      recipientEmail: 'recipient@example.com',
    }),
    resolver,
  });
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') {
    assert.equal(result.reason, 'gift_recipient_first_name_missing');
  }
});

test('gift toggle off makes the processor treat the order as a normal purchase', async () => {
  const { updateCardSettings } = await import('@memesh/db');
  const db = await freshDb();
  await updateCardSettings(db, { giftCardsEnabled: false });

  const result = await processWcOrderWebhook(db, {
    deliveryId: nextDeliveryId(),
    topic: 'order.updated',
    payload: wcGiftPayload({
      id: 2060,
      billing: { first_name: 'דנה', phone: '052-601-6010', email: 'dana8@example.com' },
      recipientPhone: '052-902-9020',
      recipientEmail: 'someone@example.com',
    }),
    resolver,
  });
  // Toggle off → gift meta is ignored, card lands on the BUYER's account.
  assert.equal(result.status, 'processed');
  if (result.status === 'processed') {
    assert.equal(result.cardsCreated.length, 1);
  }

  const cards = await db.select().from(punchCards);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.isGift, false);
  assert.equal(cards[0]?.giftBuyerFirstName, null);

  // No gift_pending_claims row either.
  const pending = await db.select().from(giftPendingClaims);
  assert.equal(pending.length, 0);
});

test('gift order re-delivery returns alreadyExisted=true with no fresh raw token', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  const payload = wcGiftPayload({
    id: 2070,
    billing: { phone: '052-701-7010', email: 'dana9@example.com' },
    recipientPhone: '052-903-9030',
    recipientEmail: 'replay@example.com',
  });

  const first = await processWcOrderWebhook(db, {
    deliveryId: 'gift-replay-d1',
    topic: 'order.updated',
    payload,
    resolver,
  });
  assert.equal(first.status, 'processed_gift_pending');
  if (first.status === 'processed_gift_pending') {
    assert.equal(first.alreadyExisted, false);
    assert.ok(first.rawClaimToken);
  }

  const second = await processWcOrderWebhook(db, {
    deliveryId: 'gift-replay-d2', // different delivery id, same order
    topic: 'order.updated',
    payload,
    resolver,
  });
  assert.equal(second.status, 'processed_gift_pending');
  if (second.status === 'processed_gift_pending') {
    assert.equal(second.alreadyExisted, true);
    assert.equal(second.rawClaimToken, undefined, 'no fresh token on re-delivery');
  }

  // Exactly one pending claim, no duplicates.
  const allPending = await findPendingClaimByOrderId(db, '2070');
  assert.ok(allPending);
  const pendingCount = await db.select().from(giftPendingClaims);
  assert.equal(pendingCount.length, 1);
});

test('gift order re-delivery for existing-recipient direct-mint returns cardsCreated empty', async () => {
  const db = await freshDbWithGiftCardsEnabled();
  await createCustomer(db, {
    firstName: 'נמען',
    lastName: 'קיים',
    phone: '0528018010',
    email: 'recipient-replay@example.com',
    source: 'website',
  });
  const payload = wcGiftPayload({
    id: 2080,
    billing: { phone: '052-802-8020', email: 'dana10@example.com' },
    recipientPhone: '052-801-8010',
    recipientEmail: 'recipient-replay@example.com',
  });

  const first = await processWcOrderWebhook(db, {
    deliveryId: 'gift-direct-d1',
    topic: 'order.updated',
    payload,
    resolver,
  });
  assert.equal(first.status, 'processed_gift_direct');
  if (first.status === 'processed_gift_direct') {
    assert.equal(first.cardsCreated.length, 1);
  }

  const second = await processWcOrderWebhook(db, {
    deliveryId: 'gift-direct-d2', // different delivery id, same order
    topic: 'order.updated',
    payload,
    resolver,
  });
  assert.equal(second.status, 'processed_gift_direct');
  if (second.status === 'processed_gift_direct') {
    assert.equal(second.cardsCreated.length, 0, 'reconciliation safety: no second mint');
  }
});

// Sanity check the unused import doesn't tree-shake to nothing.
test('findCustomerByPhoneOrEmail is exposed from @memesh/db', () => {
  assert.equal(typeof findCustomerByPhoneOrEmailFn, 'function');
});
