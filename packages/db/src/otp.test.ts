import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { requestOtp, verifyOtp } from './otp';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

type TestDb = Awaited<ReturnType<typeof freshDb>>;

const PEPPER = 'otp-test-pepper-secret';
const T0 = new Date('2026-06-17T10:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

let seq = 0;
async function seedCustomerPhone(db: TestDb): Promise<string> {
  seq += 1;
  const phone = `052-900-${String(seq).padStart(4, '0')}`;
  await createCustomer(db, { firstName: 'Noa', lastName: 'Cohen', phone });
  return phone;
}

test('requestOtp issues a code for an existing customer', async () => {
  const db = await freshDb();
  const phone = await seedCustomerPhone(db);
  const res = await requestOtp(db, phone, { pepper: PEPPER, now: T0 });
  assert.equal(res.sent, true);
  if (res.sent) assert.match(res.code, /^\d{6}$/);
});

test('requestOtp does not issue for an unknown phone (no SMS abuse)', async () => {
  const db = await freshDb();
  const res = await requestOtp(db, '052-000-0000', { pepper: PEPPER, now: T0 });
  assert.equal(res.sent, false);
  if (!res.sent) assert.equal(res.reason, 'no_customer');
});

test('requestOtp enforces a resend cooldown', async () => {
  const db = await freshDb();
  const phone = await seedCustomerPhone(db);
  const first = await requestOtp(db, phone, { pepper: PEPPER, now: T0 });
  assert.equal(first.sent, true);
  const second = await requestOtp(db, phone, { pepper: PEPPER, now: plus(5_000) });
  assert.equal(second.sent, false);
  if (!second.sent) assert.equal(second.reason, 'cooldown');
});

test('requestOtp rate-limits after too many sends in the window', async () => {
  const db = await freshDb();
  const phone = await seedCustomerPhone(db);
  await requestOtp(db, phone, { pepper: PEPPER, now: T0 });
  await requestOtp(db, phone, { pepper: PEPPER, now: plus(61_000) });
  await requestOtp(db, phone, { pepper: PEPPER, now: plus(122_000) });
  const fourth = await requestOtp(db, phone, { pepper: PEPPER, now: plus(183_000) });
  assert.equal(fourth.sent, false);
  if (!fourth.sent) assert.equal(fourth.reason, 'rate_limited');
});

test('verifyOtp accepts the correct code and resolves the customer', async () => {
  const db = await freshDb();
  const phone = await seedCustomerPhone(db);
  const req = await requestOtp(db, phone, { pepper: PEPPER, now: T0 });
  assert.equal(req.sent, true);
  if (!req.sent) return;

  const res = await verifyOtp(db, phone, req.code, { pepper: PEPPER, now: plus(10_000) });
  assert.equal(res.ok, true);
  if (res.ok) assert.match(res.customerId, /[0-9a-f-]{36}/);
});

test('verifyOtp rejects a wrong code and is single-use after success', async () => {
  const db = await freshDb();
  const phone = await seedCustomerPhone(db);
  const req = await requestOtp(db, phone, { pepper: PEPPER, now: T0 });
  assert.equal(req.sent, true);
  if (!req.sent) return;

  const wrong = await verifyOtp(db, phone, '000000', { pepper: PEPPER, now: plus(1_000) });
  assert.equal(wrong.ok, false);

  const ok = await verifyOtp(db, phone, req.code, { pepper: PEPPER, now: plus(2_000) });
  assert.equal(ok.ok, true);

  const reuse = await verifyOtp(db, phone, req.code, { pepper: PEPPER, now: plus(3_000) });
  assert.equal(reuse.ok, false); // already consumed
});

test('verifyOtp rejects an expired code', async () => {
  const db = await freshDb();
  const phone = await seedCustomerPhone(db);
  const req = await requestOtp(db, phone, { pepper: PEPPER, now: T0 });
  assert.equal(req.sent, true);
  if (!req.sent) return;

  const res = await verifyOtp(db, phone, req.code, { pepper: PEPPER, now: plus(6 * 60 * 1000) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'expired');
});

test('verifyOtp locks the code after too many wrong attempts', async () => {
  const db = await freshDb();
  const phone = await seedCustomerPhone(db);
  const req = await requestOtp(db, phone, { pepper: PEPPER, now: T0 });
  assert.equal(req.sent, true);
  if (!req.sent) return;

  for (let i = 0; i < 5; i += 1) {
    const r = await verifyOtp(db, phone, '111111', { pepper: PEPPER, now: plus(1_000 + i) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid');
  }
  // Even the correct code is now locked out.
  const locked = await verifyOtp(db, phone, req.code, { pepper: PEPPER, now: plus(10_000) });
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.equal(locked.reason, 'locked');
});
