// End-to-end tests for the fireWcPostPurchaseSms helper. PGlite-backed so
// the real getCardSettings + mintHandoffToken paths run; smsProvider is the
// real ConsoleSmsProvider singleton (test env defaults to SMS_PROVIDER=console)
// whose .sent array we inspect to confirm the SMS attempt.
//
// What we pin down here:
//   - smsOnPurchase honored (off → NO token mint, NO SMS attempt)
//   - On success → exactly one customer_login_tokens row with source='wc_checkout'
//   - On success → exactly one SMS in provider.sent matching the customer phone
//   - Body contains the magic-link URL built from env.CUSTOMER_BASE_URL
//   - Single-card body uses the per-card teaser; multi-card body does NOT
//   - Token TTL ≈ 24h (matches the long-TTL constant; SMS may sit unread)

// Set env BEFORE any module that reads config.ts is imported.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import pino from 'pino';

const { createCustomer, customerLoginTokens, updateCardSettings } =
  await import('@memesh/db');
const { fireWcPostPurchaseSms } = await import('./wc-post-purchase-sms.js');
const { smsProvider } = await import('./sms.js');
const { env } = await import('../config.js');

import type { ConsoleSmsProvider } from '@memesh/sms';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder });
  return db;
}

// Cast the singleton to the console provider so we can inspect .sent. In
// test env SMS_PROVIDER is unset → sms.ts returns a ConsoleSmsProvider, so
// this cast is sound. If someone ever flips the default we'd want to fail
// loudly, which the assertion in the first test catches.
const consoleSms = smsProvider as unknown as ConsoleSmsProvider;

// Snapshot helper. The singleton's .sent array accumulates across all tests
// in the same process, so each test captures a baseline.
function snapshotSent(): number {
  return consoleSms.sent.length;
}

// Silent log to keep test output tidy. Use pino with level: 'silent'.
const log = pino({ level: 'silent' }) as unknown as Logger;

test('fireWcPostPurchaseSms: golden path → mints a wc_checkout token and sends one SMS with the magic link', async () => {
  // Sanity-check the cast — if SMS_PROVIDER drifted, this is where we want
  // to fail fast rather than chasing phantom assertion failures below.
  assert.equal(
    smsProvider.name,
    'console',
    'test env expects SMS_PROVIDER=console — set NODE_ENV=test and leave SMS_PROVIDER unset',
  );

  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Tamar',
    lastName: 'Levi',
    phone: '0541112222',
  });
  const sentBefore = snapshotSent();

  await fireWcPostPurchaseSms(db, {
    customerId: customer.id,
    customerPhone: customer.phone,
    orderId: 'wc-1234',
    cards: [{ totalEntries: 12, expiresAt: null }],
    log,
  });

  // One token row, source='wc_checkout', orderRef='wc-1234'.
  const tokens = await db.select().from(customerLoginTokens);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]?.source, 'wc_checkout');
  assert.equal(tokens[0]?.orderRef, 'wc-1234');
  assert.equal(tokens[0]?.customerId, customer.id);
  assert.equal(tokens[0]?.consumedAt, null);

  // Token TTL: ~24h (the SMS-handoff constant). Tolerate a 60s skew for
  // the time between mint and the assertion.
  const ttlMs = tokens[0]!.expiresAt.getTime() - tokens[0]!.createdAt.getTime();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  assert.ok(
    Math.abs(ttlMs - twentyFourHoursMs) < 60_000,
    `token TTL must be ~24h, got ${ttlMs}ms`,
  );

  // Exactly one new SMS, to the customer's phone, body has the magic link.
  assert.equal(consoleSms.sent.length, sentBefore + 1, 'one new SMS sent');
  const sms = consoleSms.sent.at(-1)!;
  assert.equal(sms.to, '0541112222');
  // Short-link URL shape from _plans/2026-06-22-sms-short-link.md:
  //   ${CUSTOMER_BASE_URL}/c/<16-char base64url token>
  assert.match(
    sms.body,
    new RegExp(`${env.CUSTOMER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/c/[A-Za-z0-9_-]{16}\\b`),
    'SMS body must contain the short magic link built from env.CUSTOMER_BASE_URL',
  );
  assert.equal(
    sms.body.includes('/checkout-complete?token='),
    false,
    'legacy long-URL shape must be gone from new SMS sends',
  );
  // Single-card body uses the per-card teaser (count + expiry line).
  assert.match(sms.body, /הכרטיסייה שלך ב-Memesh נוצרה!/);
  assert.match(sms.body, /12 כניסות/);
  assert.match(sms.body, /לצפייה באזור האישי: /);
});

test('fireWcPostPurchaseSms: smsOnPurchase=false → no token minted, no SMS sent', async () => {
  const db = await freshDb();
  // Disable the master switch via the public update function (the same call
  // path the admin Settings page uses).
  await updateCardSettings(db, { smsOnPurchase: false });

  const customer = await createCustomer(db, {
    firstName: 'Noa',
    lastName: 'Cohen',
    phone: '0543334444',
  });
  const sentBefore = snapshotSent();

  await fireWcPostPurchaseSms(db, {
    customerId: customer.id,
    customerPhone: customer.phone,
    orderId: 'wc-5678',
    cards: [{ totalEntries: 6, expiresAt: null }],
    log,
  });

  const tokens = await db.select().from(customerLoginTokens);
  assert.equal(tokens.length, 0, 'master switch off → no token mint');
  assert.equal(consoleSms.sent.length, sentBefore, 'master switch off → no SMS attempt');
});

test('fireWcPostPurchaseSms: multi-card order uses the generic body (no per-card claim)', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Yossi',
    lastName: 'Mizrahi',
    phone: '0545556666',
  });
  const sentBefore = snapshotSent();

  await fireWcPostPurchaseSms(db, {
    customerId: customer.id,
    customerPhone: customer.phone,
    orderId: 'wc-multi',
    cards: [
      { totalEntries: 12, expiresAt: new Date('2027-06-22T22:00:00.000Z') },
      { totalEntries: 6, expiresAt: null },
    ],
    log,
  });

  assert.equal(consoleSms.sent.length, sentBefore + 1);
  const body = consoleSms.sent.at(-1)!.body;
  assert.match(body, /נוצרו 2 כרטיסיות חדשות ב-Memesh!/);
  assert.equal(body.includes('כניסות'), false, 'multi-card body must NOT make per-card entry claims');
});

test('fireWcPostPurchaseSms: never throws on a transient provider failure (swallowed + logged)', async () => {
  // We can't easily induce a Pulseem timeout against the console provider,
  // but the contract is "never throw, never propagate". A null customerId
  // is the easiest forced-failure: mintHandoffToken will reject the FK.
  // The helper must still return cleanly.
  const db = await freshDb();
  const sentBefore = snapshotSent();

  await assert.doesNotReject(
    fireWcPostPurchaseSms(db, {
      customerId: '00000000-0000-0000-0000-000000000000', // not a real FK
      customerPhone: '0540000000',
      orderId: 'wc-fk-fail',
      cards: [{ totalEntries: 1, expiresAt: null }],
      log,
    }),
  );

  // No SMS attempt because we never got past the token mint.
  assert.equal(consoleSms.sent.length, sentBefore, 'FK failure → no SMS attempt');
});
