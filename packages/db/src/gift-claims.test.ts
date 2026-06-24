import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer, createPunchCard } from './cards';
import {
  createGiftPendingClaim,
  findPendingClaimByOrderId,
  findPendingClaimByTokenHash,
  generateRawClaimToken,
  hashClaimToken,
  markGiftClaimComplete,
  sweepExpiredGiftClaims,
} from './gift-claims';
import { findCustomerByPhoneOrEmail } from './wc-orders';

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
function makePhone() {
  seq += 1;
  return `052-000-${String(seq).padStart(4, '0')}`;
}

function giftClaimDefaults() {
  return {
    wcOrderId: `order-${Math.random().toString(36).slice(2, 8)}`,
    wcSku: '1004',
    buyerFirstName: 'דנה',
    buyerLastName: 'בוקובסקי',
    buyerEmail: 'dana@example.com',
    buyerPhone: makePhone(),
    recipientFirstName: 'יואב',
    recipientLastName: 'כהן',
    recipientEmail: 'yoav@example.com',
    recipientPhone: makePhone(),
  };
}

// ---------------------------------------------------------------------------
// generateRawClaimToken
// ---------------------------------------------------------------------------

test('generateRawClaimToken returns a base64url-safe raw and matching sha256 hash', () => {
  const { raw, hash } = generateRawClaimToken();
  // base64url alphabet = [A-Za-z0-9_-], no padding
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  // 24 random bytes → 32 chars of base64url
  assert.equal(raw.length, 32);
  // sha256 hex digest is always 64 chars
  assert.equal(hash.length, 64);
  assert.equal(hash, hashClaimToken(raw));
});

test('generateRawClaimToken produces unique tokens across repeated calls', () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 100; i += 1) tokens.add(generateRawClaimToken().raw);
  assert.equal(tokens.size, 100);
});

// ---------------------------------------------------------------------------
// createGiftPendingClaim + findPendingClaimBy*
// ---------------------------------------------------------------------------

test('createGiftPendingClaim inserts a row and returns the raw token', async () => {
  const db = await freshDb();
  const input = giftClaimDefaults();
  const result = await createGiftPendingClaim(db, input);

  assert.match(result.rawClaimToken, /^[A-Za-z0-9_-]+$/);
  assert.equal(result.row.wcOrderId, input.wcOrderId);
  assert.equal(result.row.wcSku, input.wcSku);
  assert.equal(result.row.recipientPhone, input.recipientPhone);
  assert.equal(result.row.claimedAt, null);
  assert.equal(result.row.expiredAt, null);
  // Default 365-day TTL.
  const ttlMs = result.row.expiresAt.getTime() - result.row.createdAt.getTime();
  assert.ok(ttlMs > 364 * 86400 * 1000 && ttlMs < 366 * 86400 * 1000);
});

test('createGiftPendingClaim respects a custom ttlDays', async () => {
  const db = await freshDb();
  const now = new Date('2026-01-01T00:00:00Z');
  const result = await createGiftPendingClaim(db, {
    ...giftClaimDefaults(),
    ttlDays: 30,
    now,
  });
  const ttlMs = result.row.expiresAt.getTime() - now.getTime();
  assert.equal(ttlMs, 30 * 86400 * 1000);
});

test('findPendingClaimByTokenHash returns the row for a valid raw token', async () => {
  const db = await freshDb();
  const created = await createGiftPendingClaim(db, giftClaimDefaults());
  const found = await findPendingClaimByTokenHash(db, created.rawClaimToken);
  assert.ok(found);
  assert.equal(found.id, created.row.id);
});

test('findPendingClaimByTokenHash returns undefined for an unknown token', async () => {
  const db = await freshDb();
  const result = await findPendingClaimByTokenHash(db, 'definitely-not-a-real-token');
  assert.equal(result, undefined);
});

test('findPendingClaimByOrderId returns the pending row for a known order', async () => {
  const db = await freshDb();
  const input = giftClaimDefaults();
  await createGiftPendingClaim(db, input);
  const found = await findPendingClaimByOrderId(db, input.wcOrderId);
  assert.ok(found);
  assert.equal(found.wcOrderId, input.wcOrderId);
});

test('findPendingClaimByOrderId returns undefined for an unknown order', async () => {
  const db = await freshDb();
  const result = await findPendingClaimByOrderId(db, 'no-such-order');
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// markGiftClaimComplete
// ---------------------------------------------------------------------------

async function makeCardForClaim(db: any) {
  // Create a host customer + card so we have a valid uuid to use as
  // mintedCardId — claim transition requires it.
  const customer = await createCustomer(db, {
    firstName: 'נמען',
    lastName: 'בדיקה',
    phone: makePhone(),
    source: 'website',
  });
  const card = await createPunchCard(db, resolver, {
    customerId: customer.id,
    totalEntries: 12,
    validityDays: null,
    source: 'online',
  });
  return card.id;
}

test('markGiftClaimComplete claims a live row atomically', async () => {
  const db = await freshDb();
  const pending = await createGiftPendingClaim(db, giftClaimDefaults());
  const cardId = await makeCardForClaim(db);

  const result = await markGiftClaimComplete(db, {
    pendingId: pending.row.id,
    mintedCardId: cardId,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.row.claimedAt);
    assert.equal(result.row.mintedCardId, cardId);
  }
});

test('markGiftClaimComplete rejects a second claim of the same row as already_claimed', async () => {
  const db = await freshDb();
  const pending = await createGiftPendingClaim(db, giftClaimDefaults());
  const cardId = await makeCardForClaim(db);

  const first = await markGiftClaimComplete(db, {
    pendingId: pending.row.id,
    mintedCardId: cardId,
  });
  assert.equal(first.ok, true);

  const second = await markGiftClaimComplete(db, {
    pendingId: pending.row.id,
    mintedCardId: cardId,
  });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, 'already_claimed');
});

test('markGiftClaimComplete reports not_found for an unknown pending id', async () => {
  const db = await freshDb();
  const cardId = await makeCardForClaim(db);
  const result = await markGiftClaimComplete(db, {
    pendingId: '00000000-0000-0000-0000-000000000000',
    mintedCardId: cardId,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'not_found');
});

test('markGiftClaimComplete reports expired for a row that the sweep already stamped', async () => {
  const db = await freshDb();
  const pending = await createGiftPendingClaim(db, {
    ...giftClaimDefaults(),
    ttlDays: 1,
    now: new Date('2026-01-01T00:00:00Z'),
  });
  // Run the sweep at a later time so the row is past expires_at.
  await sweepExpiredGiftClaims(db, { now: new Date('2026-01-03T00:00:00Z') });

  const cardId = await makeCardForClaim(db);
  const result = await markGiftClaimComplete(db, {
    pendingId: pending.row.id,
    mintedCardId: cardId,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'expired');
});

// ---------------------------------------------------------------------------
// sweepExpiredGiftClaims
// ---------------------------------------------------------------------------

test('sweepExpiredGiftClaims stamps expired_at on rows past their deadline', async () => {
  const db = await freshDb();
  const past = await createGiftPendingClaim(db, {
    ...giftClaimDefaults(),
    ttlDays: 1,
    now: new Date('2026-01-01T00:00:00Z'),
  });
  const future = await createGiftPendingClaim(db, {
    ...giftClaimDefaults(),
    ttlDays: 365,
    now: new Date('2026-01-01T00:00:00Z'),
  });

  const result = await sweepExpiredGiftClaims(db, {
    now: new Date('2026-01-03T00:00:00Z'),
  });
  assert.deepEqual(result.expiredIds, [past.row.id]);

  // Confirm future row is untouched.
  const futureRow = await findPendingClaimByOrderId(db, future.row.wcOrderId);
  assert.equal(futureRow?.expiredAt, null);
});

test('sweepExpiredGiftClaims does not re-stamp rows that already expired', async () => {
  const db = await freshDb();
  await createGiftPendingClaim(db, {
    ...giftClaimDefaults(),
    ttlDays: 1,
    now: new Date('2026-01-01T00:00:00Z'),
  });

  const first = await sweepExpiredGiftClaims(db, {
    now: new Date('2026-01-03T00:00:00Z'),
  });
  assert.equal(first.expiredIds.length, 1);

  const second = await sweepExpiredGiftClaims(db, {
    now: new Date('2026-01-04T00:00:00Z'),
  });
  assert.equal(second.expiredIds.length, 0);
});

test('sweepExpiredGiftClaims does not touch already-claimed rows', async () => {
  const db = await freshDb();
  const pending = await createGiftPendingClaim(db, {
    ...giftClaimDefaults(),
    ttlDays: 1,
    now: new Date('2026-01-01T00:00:00Z'),
  });
  const cardId = await makeCardForClaim(db);
  await markGiftClaimComplete(db, {
    pendingId: pending.row.id,
    mintedCardId: cardId,
  });

  const result = await sweepExpiredGiftClaims(db, {
    now: new Date('2026-01-03T00:00:00Z'),
  });
  assert.equal(result.expiredIds.length, 0);
});

// ---------------------------------------------------------------------------
// findCustomerByPhoneOrEmail (the recipient match for the gift webhook branch)
// ---------------------------------------------------------------------------

test('findCustomerByPhoneOrEmail matches by phone first', async () => {
  const db = await freshDb();
  const phone = makePhone();
  const customer = await createCustomer(db, {
    firstName: 'נמען',
    lastName: 'קיים',
    phone,
    email: 'recipient@example.com',
    source: 'website',
  });

  const result = await findCustomerByPhoneOrEmail(db, {
    phone,
    email: 'nope@example.com',
  });
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.matchedBy, 'phone');
    assert.equal(result.customer.id, customer.id);
    assert.equal(result.conflictWithEmailMatchCustomerId, undefined);
  }
});

test('findCustomerByPhoneOrEmail falls back to email when phone misses', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'נמען',
    lastName: 'מייל',
    phone: makePhone(),
    email: 'email-only@example.com',
    source: 'website',
  });

  const result = await findCustomerByPhoneOrEmail(db, {
    phone: makePhone(), // unknown phone
    email: 'email-only@example.com',
  });
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.matchedBy, 'email');
    assert.equal(result.customer.id, customer.id);
  }
});

test('findCustomerByPhoneOrEmail flags the phone-vs-email conflict case', async () => {
  const db = await freshDb();
  const phoneOwner = await createCustomer(db, {
    firstName: 'א',
    lastName: 'טלפון',
    phone: makePhone(),
    email: 'phone-owner@example.com',
    source: 'website',
  });
  const emailOwner = await createCustomer(db, {
    firstName: 'ב',
    lastName: 'מייל',
    phone: makePhone(),
    email: 'gift-conflict@example.com',
    source: 'website',
  });

  const result = await findCustomerByPhoneOrEmail(db, {
    phone: phoneOwner.phone,
    email: 'gift-conflict@example.com',
  });
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.matchedBy, 'phone');
    assert.equal(result.customer.id, phoneOwner.id);
    assert.equal(result.conflictWithEmailMatchCustomerId, emailOwner.id);
  }
});

test('findCustomerByPhoneOrEmail returns not found when neither signal matches', async () => {
  const db = await freshDb();
  const result = await findCustomerByPhoneOrEmail(db, {
    phone: makePhone(),
    email: 'nobody@example.com',
  });
  assert.equal(result.found, false);
});

test('findCustomerByPhoneOrEmail is case-insensitive on email', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'נמען',
    lastName: 'מייל',
    phone: makePhone(),
    email: 'mixedcase@example.com',
    source: 'website',
  });

  const result = await findCustomerByPhoneOrEmail(db, {
    phone: makePhone(),
    email: 'MixedCase@Example.com',
  });
  assert.equal(result.found, true);
  if (result.found) assert.equal(result.customer.id, customer.id);
});
