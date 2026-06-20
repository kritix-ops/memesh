import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import {
  renderEmailOtpBody,
  requestEmailOtp,
  validateEmailOtpTemplate,
  verifyEmailOtp,
} from './email-otp';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

type TestDb = Awaited<ReturnType<typeof freshDb>>;

const PEPPER = 'email-otp-test-pepper-secret';
const T0 = new Date('2026-06-20T10:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

let seq = 0;
async function seedCustomerWithEmail(db: TestDb, email: string): Promise<void> {
  seq += 1;
  await createCustomer(db, {
    firstName: 'Noa',
    lastName: 'Cohen',
    phone: `052-901-${String(seq).padStart(4, '0')}`,
    email,
  });
}

test('requestEmailOtp issues a code for an email that matches a customer', async () => {
  const db = await freshDb();
  await seedCustomerWithEmail(db, 'noa@example.com');
  const res = await requestEmailOtp(db, 'noa@example.com', { pepper: PEPPER, now: T0 });
  assert.equal(res.sent, true);
  if (res.sent) {
    assert.match(res.code, /^\d{6}$/);
    assert.equal(res.firstName, 'Noa');
  }
});

test('requestEmailOtp normalizes case + whitespace so the lookup matches the stored email', async () => {
  const db = await freshDb();
  await seedCustomerWithEmail(db, 'noa@example.com');
  const res = await requestEmailOtp(db, '  Noa@Example.COM  ', { pepper: PEPPER, now: T0 });
  assert.equal(res.sent, true);
});

test('requestEmailOtp does not issue for an unknown email (no spam vector)', async () => {
  const db = await freshDb();
  const res = await requestEmailOtp(db, 'stranger@example.com', { pepper: PEPPER, now: T0 });
  assert.equal(res.sent, false);
  if (!res.sent) assert.equal(res.reason, 'no_customer');
});

test('requestEmailOtp enforces a resend cooldown', async () => {
  const db = await freshDb();
  await seedCustomerWithEmail(db, 'cool@example.com');
  const first = await requestEmailOtp(db, 'cool@example.com', { pepper: PEPPER, now: T0 });
  assert.equal(first.sent, true);
  const second = await requestEmailOtp(db, 'cool@example.com', {
    pepper: PEPPER,
    now: plus(5_000),
  });
  assert.equal(second.sent, false);
  if (!second.sent) assert.equal(second.reason, 'cooldown');
});

test('requestEmailOtp rate-limits after too many sends in the window', async () => {
  const db = await freshDb();
  await seedCustomerWithEmail(db, 'busy@example.com');
  await requestEmailOtp(db, 'busy@example.com', { pepper: PEPPER, now: T0 });
  await requestEmailOtp(db, 'busy@example.com', { pepper: PEPPER, now: plus(61_000) });
  await requestEmailOtp(db, 'busy@example.com', { pepper: PEPPER, now: plus(122_000) });
  const fourth = await requestEmailOtp(db, 'busy@example.com', {
    pepper: PEPPER,
    now: plus(183_000),
  });
  assert.equal(fourth.sent, false);
  if (!fourth.sent) assert.equal(fourth.reason, 'rate_limited');
});

test('verifyEmailOtp accepts the correct code and resolves the customer', async () => {
  const db = await freshDb();
  await seedCustomerWithEmail(db, 'verify@example.com');
  const req = await requestEmailOtp(db, 'verify@example.com', { pepper: PEPPER, now: T0 });
  assert.equal(req.sent, true);
  if (!req.sent) return;

  const res = await verifyEmailOtp(db, 'verify@example.com', req.code, {
    pepper: PEPPER,
    now: plus(10_000),
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.match(res.customerId, /[0-9a-f-]{36}/);
});

test('verifyEmailOtp rejects a wrong code and is single-use after success', async () => {
  const db = await freshDb();
  await seedCustomerWithEmail(db, 'one-shot@example.com');
  const req = await requestEmailOtp(db, 'one-shot@example.com', { pepper: PEPPER, now: T0 });
  assert.equal(req.sent, true);
  if (!req.sent) return;

  const wrong = await verifyEmailOtp(db, 'one-shot@example.com', '000000', {
    pepper: PEPPER,
    now: plus(1_000),
  });
  assert.equal(wrong.ok, false);

  const ok = await verifyEmailOtp(db, 'one-shot@example.com', req.code, {
    pepper: PEPPER,
    now: plus(2_000),
  });
  assert.equal(ok.ok, true);

  const reuse = await verifyEmailOtp(db, 'one-shot@example.com', req.code, {
    pepper: PEPPER,
    now: plus(3_000),
  });
  assert.equal(reuse.ok, false);
});

test('verifyEmailOtp rejects an expired code (10-minute TTL)', async () => {
  const db = await freshDb();
  await seedCustomerWithEmail(db, 'slow@example.com');
  const req = await requestEmailOtp(db, 'slow@example.com', { pepper: PEPPER, now: T0 });
  assert.equal(req.sent, true);
  if (!req.sent) return;

  const res = await verifyEmailOtp(db, 'slow@example.com', req.code, {
    pepper: PEPPER,
    now: plus(11 * 60 * 1000),
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'expired');
});

test('verifyEmailOtp locks after too many wrong attempts', async () => {
  const db = await freshDb();
  await seedCustomerWithEmail(db, 'lock@example.com');
  const req = await requestEmailOtp(db, 'lock@example.com', { pepper: PEPPER, now: T0 });
  assert.equal(req.sent, true);
  if (!req.sent) return;

  for (let i = 0; i < 5; i += 1) {
    const r = await verifyEmailOtp(db, 'lock@example.com', '111111', {
      pepper: PEPPER,
      now: plus(1_000 + i),
    });
    assert.equal(r.ok, false);
  }
  const locked = await verifyEmailOtp(db, 'lock@example.com', req.code, {
    pepper: PEPPER,
    now: plus(10_000),
  });
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.equal(locked.reason, 'locked');
});

test('renderEmailOtpBody substitutes both placeholders and falls back when firstName is missing', () => {
  const t = 'שלום {{firstName}}, הקוד הוא {{code}}.';
  assert.equal(renderEmailOtpBody(t, { firstName: 'יונה', code: '123456' }), 'שלום יונה, הקוד הוא 123456.');
  assert.equal(renderEmailOtpBody(t, { firstName: null, code: '999999' }), 'שלום לקוח/ה, הקוד הוא 999999.');
  assert.equal(renderEmailOtpBody(t, { firstName: '   ', code: '000000' }), 'שלום לקוח/ה, הקוד הוא 000000.');
});

test('validateEmailOtpTemplate accepts known placeholders and rejects unknown ones', () => {
  assert.deepEqual(validateEmailOtpTemplate('שלום {{firstName}}, {{code}}'), { ok: true });
  assert.deepEqual(validateEmailOtpTemplate('plain text, no placeholders'), { ok: true });
  const bad = validateEmailOtpTemplate('שלום {{name}}, {{otp}}');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual(bad.unknown.sort(), ['name', 'otp'].sort());
  }
});
