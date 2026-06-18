import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { verifyToken, type KeyResolver } from '@memesh/qr-engine';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { listStaffActions } from './actions';
import {
  allocateCustomerNumber,
  cancelCard,
  createCustomer,
  createPunchCard,
  listCards,
} from './cards';
import { punchCard } from './punch';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

type TestDb = Awaited<ReturnType<typeof freshDb>>;

const TEST_SECRET = 'test-secret-that-is-at-least-32-characters';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: 'test-key', secret: TEST_SECRET }),
  resolveVerifyKey: (keyId) => (keyId === 'test-key' ? TEST_SECRET : undefined),
};

let seq = 0;
async function makeCustomer(db: TestDb) {
  seq += 1;
  return createCustomer(db, {
    firstName: 'Noa',
    lastName: 'Cohen',
    phone: `052-000-${String(seq).padStart(4, '0')}`,
  });
}

test('createCustomer allocates sequential L-NNNN customer numbers', async () => {
  const db = await freshDb();
  const a = await makeCustomer(db);
  const b = await makeCustomer(db);
  assert.match(a.customerNumber, /^L-\d{4}$/);
  assert.match(b.customerNumber, /^L-\d{4}$/);
  assert.notEqual(a.customerNumber, b.customerNumber);
});

test('createPunchCard mints a serial + signed QR and stores a 12-entry card', async () => {
  const db = await freshDb();
  const customer = await makeCustomer(db);

  const card = await createPunchCard(db, resolver, { customerId: customer.id });

  assert.match(card.serialNumber, /^M-\d{8}-\d{4,5}$/);
  assert.equal(card.totalEntries, 12);
  assert.equal(card.usedEntries, 0);
  assert.equal(card.isActive, true);
  assert.equal(card.keyId, 'test-key');
  assert.ok(card.expiresAt.getTime() > Date.now());
});

test('the minted QR token verifies and points back to the card', async () => {
  const db = await freshDb();
  const customer = await makeCustomer(db);
  const card = await createPunchCard(db, resolver, { customerId: customer.id });

  const verified = verifyToken(card.qrToken, resolver);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.payload.punchCardId, card.id);
    assert.equal(verified.payload.customerId, customer.id);
    assert.equal(verified.payload.serial, card.serialNumber);
    assert.equal(verified.payload.keyId, 'test-key');
  }
});

test('a tampered QR token for a created card is rejected', async () => {
  const db = await freshDb();
  const customer = await makeCustomer(db);
  const card = await createPunchCard(db, resolver, { customerId: customer.id });

  const parts = card.qrToken.split('.');
  const forged = [parts[0], parts[1], 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'].join('.');
  const verified = verifyToken(forged, resolver);
  assert.equal(verified.ok, false);
});

test('end to end: create card, then punch it via the verified card id', async () => {
  const db = await freshDb();
  const customer = await makeCustomer(db);
  const card = await createPunchCard(db, resolver, { customerId: customer.id });

  const verified = verifyToken(card.qrToken, resolver);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;

  const result = await punchCard(db, {
    punchCardId: verified.payload.punchCardId,
    method: 'qr_scan',
    audit: { qrTokenHash: 'hash-of-token' },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.usedEntries, 1);
    assert.equal(result.remaining, 11);
  }
});

test('customer numbers and serials use independent sequences', async () => {
  const db = await freshDb();
  const c1 = await makeCustomer(db);
  await createPunchCard(db, resolver, { customerId: c1.id });
  const c2 = await makeCustomer(db);

  // Two customers created with one card between them: customer numbers advance
  // by one each, independent of how many serials were allocated.
  const n1 = Number(c1.customerNumber.slice(2));
  const n2 = Number(c2.customerNumber.slice(2));
  assert.equal(n2, n1 + 1);

  // And the customer-number sequence keeps advancing.
  const next = await allocateCustomerNumber(db);
  assert.equal(Number(next.slice(2)), n2 + 1);
});

test('cancelCard deactivates a card, records the reason, and logs an action', async () => {
  const db = await freshDb();
  const cust = await makeCustomer(db);
  const card = await createPunchCard(db, resolver, { customerId: cust.id });

  const cancelled = await cancelCard(db, { cardId: card.id, reason: 'בקשת לקוח' });
  assert.ok(cancelled);
  assert.equal(cancelled.isActive, false);
  assert.equal(cancelled.cancelReason, 'בקשת לקוח');
  assert.ok(cancelled.cancelledAt);

  const actions = await listStaffActions(db);
  assert.ok(actions.some((a) => a.action === 'cancel_card'));
});

test('a cancelled card cannot be punched', async () => {
  const db = await freshDb();
  const cust = await makeCustomer(db);
  const card = await createPunchCard(db, resolver, { customerId: cust.id });
  await cancelCard(db, { cardId: card.id, reason: 'בדיקה' });

  const res = await punchCard(db, { punchCardId: card.id, method: 'qr_scan' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'inactive');
});

// listCards bucket tests: seed one of each state and verify the filters
// return mutually exclusive results.
test('listCards filters by status (active / cancelled / expired)', async () => {
  const db = await freshDb();
  const cust = await makeCustomer(db);

  // active: untouched fresh card
  const activeCard = await createPunchCard(db, resolver, { customerId: cust.id });
  // cancelled: cancel it
  const toCancel = await createPunchCard(db, resolver, { customerId: cust.id });
  await cancelCard(db, { cardId: toCancel.id, reason: 'בדיקת ביטול' });
  // expired: punch to exhaustion. After the 12th punch the card flips is_active=false
  // with cancelled_at NULL — which is exactly the "expired" bucket in listCards.
  const toExhaust = await createPunchCard(db, resolver, { customerId: cust.id });
  for (let i = 0; i < 12; i += 1) {
    await punchCard(db, { punchCardId: toExhaust.id, method: 'serial' });
  }

  const active = await listCards(db, { status: 'active' });
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, activeCard.id);
  assert.equal(active[0]?.customerFirstName, 'Noa');

  const cancelled = await listCards(db, { status: 'cancelled' });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]?.id, toCancel.id);
  assert.equal(cancelled[0]?.cancelReason, 'בדיקת ביטול');

  const expired = await listCards(db, { status: 'expired' });
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.id, toExhaust.id);
});

test('listCards without a status returns all rows joined with customer info', async () => {
  const db = await freshDb();
  const cust = await makeCustomer(db);
  await createPunchCard(db, resolver, { customerId: cust.id });
  await createPunchCard(db, resolver, { customerId: cust.id });

  const all = await listCards(db);
  assert.equal(all.length, 2);
  assert.equal(all[0]?.customerLastName, 'Cohen');
  assert.ok(all[0]?.customerNumber?.startsWith('L-'));
});

test('listCards respects the limit option', async () => {
  const db = await freshDb();
  const cust = await makeCustomer(db);
  await createPunchCard(db, resolver, { customerId: cust.id });
  await createPunchCard(db, resolver, { customerId: cust.id });
  await createPunchCard(db, resolver, { customerId: cust.id });

  const limited = await listCards(db, { limit: 2 });
  assert.equal(limited.length, 2);
});
