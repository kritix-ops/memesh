// Route-level tests for GET /customers — the staff/admin customer directory.
// Pins the auth gate, query-param validation, and that all staff roles may
// list. Sorting/filtering/pagination semantics live with the DB helper tests
// in packages/db/src/customer-directory.test.ts.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { signAccessToken } = await import('@memesh/auth');
const { authConfig } = await import('../auth.js');
const { buildApp } = await import('../app.js');
const app: FastifyInstance = await buildApp();
await app.ready();

after(async () => {
  await app.close();
});

const tokenFor = (role: 'admin' | 'manager' | 'cashier') =>
  signAccessToken({ sub: '00000000-0000-0000-0000-000000000001', role }, authConfig);

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test('GET /customers without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/customers' });
  assert.equal(res.statusCode, 401);
});

test('GET /customers as a cashier reaches the DB branch (all staff roles allowed)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/customers',
    headers: auth(await tokenFor('cashier')),
  });
  // 200 if the test box has a real DB; 500 if not. Either way auth + role passed.
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
  if (res.statusCode !== 200) return;
  const body = res.json();
  assert.ok(Array.isArray(body.results), 'results is an array');
  assert.equal(typeof body.total, 'number', 'total is a number');
});

test('GET /customers rejects an unknown sort', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/customers?sort=phone',
    headers: auth(await tokenFor('cashier')),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_query');
});

test('GET /customers rejects an unknown status and a non-boolean hasActiveCard', async () => {
  for (const url of ['/customers?status=deleted', '/customers?hasActiveCard=maybe']) {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: auth(await tokenFor('cashier')),
    });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error, 'invalid_query', url);
  }
});

test('GET /customers rejects out-of-range pagination params', async () => {
  for (const url of ['/customers?limit=0', '/customers?limit=101', '/customers?offset=-1']) {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: auth(await tokenFor('cashier')),
    });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error, 'invalid_query', url);
  }
});

test('GET /customers accepts the full browse param set', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/customers?q=%D7%A0%D7%95%D7%A2%D7%94&sort=lastPurchase&status=vip&hasActiveCard=true&limit=30&offset=30',
    headers: auth(await tokenFor('manager')),
  });
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
});

// PATCH /customers/:id/phone — staff phone override. DB-behavior (collision,
// success, no-op) lives in packages/db/src/accounts.test.ts; here we pin the
// auth gate, role gate, and input validation.

const uuid = '00000000-0000-0000-0000-000000000002';

test('PATCH /customers/:id/phone without a token returns 401', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/customers/${uuid}/phone`,
    payload: { phone: '050-123-4567' },
  });
  assert.equal(res.statusCode, 401);
});

test('PATCH /customers/:id/phone as a cashier is forbidden (admin/manager only)', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/customers/${uuid}/phone`,
    headers: auth(await tokenFor('cashier')),
    payload: { phone: '050-123-4567' },
  });
  assert.equal(res.statusCode, 403);
});

test('PATCH /customers/:id/phone rejects a non-uuid id', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/customers/not-a-uuid/phone',
    headers: auth(await tokenFor('admin')),
    payload: { phone: '050-123-4567' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_id');
});

test('PATCH /customers/:id/phone rejects an empty / invalid phone body', async () => {
  for (const payload of [{}, { phone: '' }, { phone: '   ' }]) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/customers/${uuid}/phone`,
      headers: auth(await tokenFor('admin')),
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, 'invalid_body', JSON.stringify(payload));
  }
});
