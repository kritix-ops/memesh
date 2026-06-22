import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import {
  cleanupHandoffTokens,
  consumeHandoffToken,
  generateRawHandoffToken,
  mintHandoffToken,
} from './handoff-tokens';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

type TestDb = Awaited<ReturnType<typeof freshDb>>;

const T0 = new Date('2026-06-21T12:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

let seq = 0;
async function seedCustomer(db: TestDb): Promise<string> {
  seq += 1;
  const phone = `052-100-${String(seq).padStart(4, '0')}`;
  const row = await createCustomer(db, { firstName: 'Noa', lastName: 'Cohen', phone });
  return row.id;
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

test('generateRawHandoffToken returns a base64url string and matching sha256 hash', () => {
  const { raw, hash } = generateRawHandoffToken();
  // 12 bytes -> base64url with no padding is 16 chars. The shorter token
  // is what lets the SMS magic link fit inside a single Hebrew-unicode
  // segment. See _plans/2026-06-22-sms-short-link.md for the security
  // analysis (96 bits is well above the threshold for single-use 24h
  // tokens against a rate-limited verify endpoint).
  assert.equal(raw.length, 16);
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]+$/);
});

test('generateRawHandoffToken produces unique tokens across calls', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    const { raw } = generateRawHandoffToken();
    assert.equal(seen.has(raw), false, 'expected fresh entropy each call');
    seen.add(raw);
  }
});

// ---------------------------------------------------------------------------
// mint + consume
// ---------------------------------------------------------------------------

test('mintHandoffToken stores a row and returns the raw token for the caller', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  const minted = await mintHandoffToken(db, {
    customerId,
    source: 'wc_checkout',
    orderRef: 'wc-12345',
    now: T0,
  });
  assert.equal(typeof minted.raw, 'string');
  assert.equal(minted.raw.length, 16);
  assert.equal(minted.expiresAt.getTime(), T0.getTime() + 5 * 60 * 1000);
});

test('mintHandoffToken accepts source: pos_sell and respects a custom ttlMs override', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  const ttlMs = 24 * 60 * 60 * 1000;
  const minted = await mintHandoffToken(db, {
    customerId,
    source: 'pos_sell',
    orderRef: 'card-uuid-abc',
    ttlMs,
    now: T0,
  });
  assert.equal(minted.expiresAt.getTime(), T0.getTime() + ttlMs);
  const res = await consumeHandoffToken(db, minted.raw, { now: plus(1_000) });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.customerId, customerId);
    assert.equal(res.source, 'pos_sell');
  }
});

test('consumeHandoffToken: valid token returns ok with customerId and marks the row consumed', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  const { raw } = await mintHandoffToken(db, {
    customerId,
    source: 'wc_checkout',
    orderRef: 'wc-1',
    now: T0,
  });
  const res = await consumeHandoffToken(db, raw, { now: plus(1_000) });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.customerId, customerId);
    assert.equal(res.source, 'wc_checkout');
  }
});

test('consumeHandoffToken: second consume of the same token returns invalid_or_consumed (atomic single-use)', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  const { raw } = await mintHandoffToken(db, {
    customerId,
    source: 'wc_checkout',
    orderRef: 'wc-1',
    now: T0,
  });
  const first = await consumeHandoffToken(db, raw, { now: plus(1_000) });
  assert.equal(first.ok, true);
  const second = await consumeHandoffToken(db, raw, { now: plus(2_000) });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, 'invalid_or_consumed');
});

test('consumeHandoffToken: unknown token returns invalid_or_consumed (no enumeration oracle)', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  await mintHandoffToken(db, { customerId, source: 'wc_checkout', now: T0 });
  // A token that was never minted should fail identically to a consumed one.
  const fakeToken = generateRawHandoffToken().raw;
  const res = await consumeHandoffToken(db, fakeToken, { now: plus(1_000) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'invalid_or_consumed');
});

test('consumeHandoffToken: garbage input returns invalid_or_consumed without throwing', async () => {
  const db = await freshDb();
  await seedCustomer(db);
  const res = await consumeHandoffToken(db, 'not-a-real-token', { now: T0 });
  assert.equal(res.ok, false);
});

test('consumeHandoffToken: expired token returns expired (after the atomic update burned the row)', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  const { raw } = await mintHandoffToken(db, {
    customerId,
    source: 'wc_checkout',
    ttlMs: 1_000,
    now: T0,
  });
  // 2 seconds later — past the 1-second TTL.
  const res = await consumeHandoffToken(db, raw, { now: plus(2_000) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'expired');
});

test('consumeHandoffToken: parallel consumers race — only one wins', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  const { raw } = await mintHandoffToken(db, {
    customerId,
    source: 'wc_checkout',
    now: T0,
  });
  // Fire both at the same time; the DB's atomic update guarantees exactly one
  // ok:true and one ok:false even under contention.
  const [a, b] = await Promise.all([
    consumeHandoffToken(db, raw, { now: plus(1_000) }),
    consumeHandoffToken(db, raw, { now: plus(1_000) }),
  ]);
  const oks = [a, b].filter((r) => r.ok).length;
  const fails = [a, b].filter((r) => !r.ok).length;
  assert.equal(oks, 1, 'exactly one consumer wins');
  assert.equal(fails, 1, 'the loser sees invalid_or_consumed');
});

test('deleting a customer cascades to their handoff tokens (no orphan rows)', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  await mintHandoffToken(db, { customerId, source: 'wc_checkout', now: T0 });
  // Direct delete to test the FK cascade; in prod the deleteCustomerById
  // route would be called instead.
  const { customers } = await import('./schema/index');
  const { eq } = await import('drizzle-orm');
  await db.delete(customers).where(eq(customers.id, customerId));
  const { customerLoginTokens } = await import('./schema/index');
  const remaining = await db.select().from(customerLoginTokens);
  assert.equal(remaining.length, 0, 'tokens for a deleted customer are gone');
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

test('cleanupHandoffTokens deletes rows whose expiry is older than the retention window', async () => {
  const db = await freshDb();
  const customerId = await seedCustomer(db);
  // Old (10 days past expiry): should be deleted.
  await mintHandoffToken(db, {
    customerId,
    source: 'wc_checkout',
    ttlMs: 1_000,
    now: new Date(T0.getTime() - 10 * 24 * 60 * 60 * 1000),
  });
  // Recent (just expired): should NOT be deleted (within the 7-day buffer).
  await mintHandoffToken(db, {
    customerId,
    source: 'wc_checkout',
    ttlMs: 1_000,
    now: plus(-2_000),
  });
  const res = await cleanupHandoffTokens(db, { now: T0 });
  assert.equal(res.deleted, 1, 'only the long-expired row is reaped');
});
