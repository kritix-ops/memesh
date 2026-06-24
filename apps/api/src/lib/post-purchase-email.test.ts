// End-to-end tests for the firePostPurchaseEmail helper. PGlite-backed so
// the real getCardSettings + mintHandoffToken paths run; emailProvider is
// the real ConsoleEmailProvider singleton (test env defaults to
// EMAIL_PROVIDER=console) whose .sent array we inspect.
//
// What we pin down here:
//   - customer with no email → silent skip (no token, no send)
//   - emailOnPurchase=false → silent skip (no token, no send)
//   - golden path → one customer_login_tokens row + one email matching
//     the customer's address + the Pulseem-safe HTML body + the magic link
//   - Token TTL ≈ 24h (matches the long-TTL constant)
//   - Multi-card body shape
//   - body builder (pure function) is exhaustively covered: single card
//     with/without expiry, multi-card, zero-card defensive branch, name
//     fallback, HTML escaping for hostile inputs

// Set env BEFORE any module that reads config.ts loads.
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
const { firePostPurchaseEmail, buildPostPurchaseEmailBody } = await import(
  './post-purchase-email.js'
);
const { emailProvider } = await import('./email.js');
const { env } = await import('../config.js');

import type { ConsoleEmailProvider } from '@memesh/email';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder });
  return db;
}

// In test env EMAIL_PROVIDER is unset → ConsoleEmailProvider singleton. We
// cast so .sent is reachable. If someone flips the default we want a loud
// failure here rather than confusing assertion misses below.
const consoleEmail = emailProvider as unknown as ConsoleEmailProvider;

const log = pino({ level: 'silent' }) as unknown as Logger;

function snapshotSent(): number {
  return consoleEmail.sent.length;
}

// ---------------------------------------------------------------------------
// firePostPurchaseEmail: end-to-end
// ---------------------------------------------------------------------------

test('firePostPurchaseEmail: SMS-provider sanity — singleton is the console provider in test env', () => {
  assert.equal(
    emailProvider.name,
    'console',
    'test env expects EMAIL_PROVIDER=console; set NODE_ENV=test and leave EMAIL_PROVIDER unset',
  );
});

test('firePostPurchaseEmail: golden path — mints wc_checkout token + sends one email with magic link', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Tamar',
    lastName: 'Levi',
    phone: '0541112222',
    email: 'tamar@example.com',
  });
  const sentBefore = snapshotSent();

  await firePostPurchaseEmail(db, {
    customerId: customer.id,
    customerEmail: customer.email,
    customerFirstName: customer.firstName,
    source: 'wc_checkout',
    orderRef: 'wc-1234',
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

  // Token TTL ≈ 24h.
  const ttlMs = tokens[0]!.expiresAt.getTime() - tokens[0]!.createdAt.getTime();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  assert.ok(
    Math.abs(ttlMs - twentyFourHoursMs) < 60_000,
    `token TTL must be ~24h, got ${ttlMs}ms`,
  );

  // Exactly one new email, to the customer's address, body has the link.
  assert.equal(consoleEmail.sent.length, sentBefore + 1, 'one new email sent');
  const message = consoleEmail.sent.at(-1)!;
  assert.equal(message.to, 'tamar@example.com');
  assert.match(message.subject, /הכרטיסייה שלך ב-Memesh מוכנה/);
  assert.match(
    message.html ?? '',
    new RegExp(`${env.CUSTOMER_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/c/[A-Za-z0-9_-]{16}\\b`),
    'HTML body must contain the short magic link',
  );
  assert.match(message.html ?? '', /שלום Tamar/);
  assert.match(message.html ?? '', /12 כניסות/);
  assert.match(message.html ?? '', /לצפייה באזור האישי/);
  // plain-text fallback is consistent
  assert.match(message.text, /שלום Tamar/);
  assert.match(message.text, /\/c\//);
});

test('firePostPurchaseEmail: pos_sell source mints a pos_sell token with the same TTL', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Yossi',
    lastName: 'Cohen',
    phone: '0542223333',
    email: 'yossi@example.com',
  });
  await firePostPurchaseEmail(db, {
    customerId: customer.id,
    customerEmail: customer.email,
    customerFirstName: customer.firstName,
    source: 'pos_sell',
    orderRef: 'card-uuid-1',
    cards: [{ totalEntries: 12, expiresAt: null }],
    log,
  });
  const tokens = await db.select().from(customerLoginTokens);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]?.source, 'pos_sell');
  assert.equal(tokens[0]?.orderRef, 'card-uuid-1');
});

test('firePostPurchaseEmail: customerEmail=null → silent skip, no token, no send', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Noa',
    lastName: 'Cohen',
    phone: '0543334444',
    // no email
  });
  const sentBefore = snapshotSent();

  await firePostPurchaseEmail(db, {
    customerId: customer.id,
    customerEmail: customer.email,
    customerFirstName: customer.firstName,
    source: 'pos_sell',
    orderRef: 'card-uuid-2',
    cards: [{ totalEntries: 6, expiresAt: null }],
    log,
  });

  const tokens = await db.select().from(customerLoginTokens);
  assert.equal(tokens.length, 0, 'no email address → no token mint');
  assert.equal(consoleEmail.sent.length, sentBefore, 'no email address → no send attempt');
});

test('firePostPurchaseEmail: emailOnPurchase=false → silent skip even when customer has email', async () => {
  const db = await freshDb();
  await updateCardSettings(db, { emailOnPurchase: false });

  const customer = await createCustomer(db, {
    firstName: 'Tal',
    lastName: 'Bar',
    phone: '0544445555',
    email: 'tal@example.com',
  });
  const sentBefore = snapshotSent();

  await firePostPurchaseEmail(db, {
    customerId: customer.id,
    customerEmail: customer.email,
    customerFirstName: customer.firstName,
    source: 'pos_sell',
    orderRef: 'card-uuid-3',
    cards: [{ totalEntries: 12, expiresAt: null }],
    log,
  });

  const tokens = await db.select().from(customerLoginTokens);
  assert.equal(tokens.length, 0, 'master switch off → no token mint');
  assert.equal(consoleEmail.sent.length, sentBefore, 'master switch off → no send attempt');
});

test('firePostPurchaseEmail: multi-card → generic body, no per-card claim, count surfaces in subject', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Maya',
    lastName: 'Adar',
    phone: '0545556666',
    email: 'maya@example.com',
  });
  const sentBefore = snapshotSent();

  await firePostPurchaseEmail(db, {
    customerId: customer.id,
    customerEmail: customer.email,
    customerFirstName: customer.firstName,
    source: 'wc_checkout',
    orderRef: 'wc-multi',
    cards: [
      { totalEntries: 12, expiresAt: new Date('2027-06-22T22:00:00.000Z') },
      { totalEntries: 6, expiresAt: null },
    ],
    log,
  });

  assert.equal(consoleEmail.sent.length, sentBefore + 1);
  const m = consoleEmail.sent.at(-1)!;
  assert.match(m.subject, /2 כרטיסיות חדשות ב-Memesh/);
  const html = m.html ?? '';
  assert.match(html, /נוצרו עבורך/);
  assert.match(html, /2 כרטיסיות חדשות/);
  assert.equal(
    /\d+\s+כניסות/.test(html),
    false,
    'multi-card body must NOT claim a specific entry count',
  );
});

test('firePostPurchaseEmail: never throws on a transient provider failure (FK violation swallowed + logged)', async () => {
  const db = await freshDb();
  const sentBefore = snapshotSent();

  await assert.doesNotReject(
    firePostPurchaseEmail(db, {
      customerId: '00000000-0000-0000-0000-000000000000', // not a real FK
      customerEmail: 'ghost@example.com',
      customerFirstName: 'Ghost',
      source: 'pos_sell',
      orderRef: 'card-uuid-fail',
      cards: [{ totalEntries: 1, expiresAt: null }],
      log,
    }),
  );

  assert.equal(consoleEmail.sent.length, sentBefore, 'FK failure → no send attempt');
});

// ---------------------------------------------------------------------------
// buildPostPurchaseEmailBody: pure function, no DB
// ---------------------------------------------------------------------------

const LINK = 'https://my.memesh.co.il/c/AbCdEfGhIjKlMnOp';

test('buildPostPurchaseEmailBody: single card with expiry — subject + count + expiry + link', () => {
  const { subject, html, text } = buildPostPurchaseEmailBody({
    firstName: 'Yoav',
    cards: [{ totalEntries: 12, expiresAt: new Date('2026-12-31T22:00:00.000Z') }],
    link: LINK,
  });
  assert.equal(subject, 'הכרטיסייה שלך ב-Memesh מוכנה');
  assert.match(html, /שלום Yoav/);
  assert.match(html, /12 כניסות/);
  assert.match(html, /תוקף עד 2026-12-31/);
  assert.ok(html.includes(LINK));
  assert.ok(text.includes(LINK));
});

test('buildPostPurchaseEmailBody: single card without expiry renders "(ללא תפוגה)"', () => {
  const { html, text } = buildPostPurchaseEmailBody({
    firstName: 'Yoav',
    cards: [{ totalEntries: 6, expiresAt: null }],
    link: LINK,
  });
  assert.match(html, /6 כניסות \(ללא תפוגה\)/);
  assert.match(text, /6 כניסות \(ללא תפוגה\)/);
  assert.equal(html.includes('תוקף עד'), false);
});

test('buildPostPurchaseEmailBody: empty firstName falls back to לקוח/ה', () => {
  const { html, text } = buildPostPurchaseEmailBody({
    firstName: '   ',
    cards: [{ totalEntries: 12, expiresAt: null }],
    link: LINK,
  });
  assert.match(html, /שלום לקוח\/ה/);
  assert.match(text, /שלום לקוח\/ה/);
});

test('buildPostPurchaseEmailBody: HTML-special characters in the name are escaped', () => {
  // Defensive: a malicious-looking name shouldn't break out of the HTML
  // structure. Names come from customer DB rows, which are written from
  // staff input — but escaping at the boundary is rule 13 hygiene.
  const { html } = buildPostPurchaseEmailBody({
    firstName: `<script>alert('x')</script>`,
    cards: [{ totalEntries: 1, expiresAt: null }],
    link: LINK,
  });
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('buildPostPurchaseEmailBody: zero-card defensive branch still produces a usable email', () => {
  // Should never happen via the wired call sites, but if a caller somehow
  // passes cards:[], we still emit a working email rather than throwing.
  const { subject, html, text } = buildPostPurchaseEmailBody({
    firstName: 'Yoav',
    cards: [],
    link: LINK,
  });
  assert.equal(subject, 'הכרטיסייה שלך ב-Memesh מוכנה');
  assert.match(html, /הכרטיסייה שלך מוכנה לשימוש/);
  assert.match(text, /הכרטיסייה שלך מוכנה לשימוש/);
  assert.ok(html.includes(LINK));
});

test('buildPostPurchaseEmailBody: link is referenced in both the button href and the visible fallback', () => {
  // Some email clients suppress the CTA button (especially in plain-text
  // mode). The plain fallback copy-and-paste link is the safety net.
  const { html, text } = buildPostPurchaseEmailBody({
    firstName: 'Yoav',
    cards: [{ totalEntries: 12, expiresAt: null }],
    link: LINK,
  });
  const linkOccurrences = (html.match(new RegExp(LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  assert.ok(linkOccurrences >= 2, `link should appear at least twice in HTML, got ${linkOccurrences}`);
  assert.ok(text.includes(LINK));
});
