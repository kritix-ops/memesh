// Route-level tests for the dashboard settings edit surface:
//   GET   /admin/dashboard/settings  (admin-only read of the full row)
//   PATCH /admin/dashboard/settings  (admin-only partial update)
// Pins the auth + role gate and the pre-DB body validation. Range and
// cross-field validation is exercised in packages/db/src/dashboard-settings.test.ts
// where the helper lives; here we pin the HTTP/middleware boundary only.

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

// ---------------------------------------------------------------------------
// GET — admin-only
// ---------------------------------------------------------------------------

test('GET /admin/dashboard/settings without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/dashboard/settings' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/dashboard/settings as a cashier returns 403', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/settings',
    headers: auth(await tokenFor('cashier')),
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/dashboard/settings as a manager returns 403 (admin-only)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/settings',
    headers: auth(await tokenFor('manager')),
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/dashboard/settings as an admin reaches the DB branch', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/settings',
    headers: auth(await tokenFor('admin')),
  });
  // 200 if the test box has a real DB; 500 if not. Either way auth + role passed.
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
  if (res.statusCode !== 200) return;
  const body = res.json();
  assert.ok(body.settings && typeof body.settings === 'object', 'settings object present');
  assert.equal(typeof body.settings.refreshIntervalSeconds, 'number');
  assert.equal(typeof body.settings.showRevenue, 'boolean');
  assert.ok(Array.isArray(body.settings.widgetsOrder), 'widgetsOrder is an array');
});

// ---------------------------------------------------------------------------
// PATCH — admin-only + body validation (pre-DB, so deterministic without a DB)
// ---------------------------------------------------------------------------

test('PATCH /admin/dashboard/settings without a token returns 401', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/dashboard/settings',
    payload: { showWeekAhead: false },
  });
  assert.equal(res.statusCode, 401);
});

test('PATCH /admin/dashboard/settings as a manager returns 403 (admin-only)', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/dashboard/settings',
    headers: auth(await tokenFor('manager')),
    payload: { showWeekAhead: false },
  });
  assert.equal(res.statusCode, 403);
});

test('PATCH /admin/dashboard/settings rejects a wrong-typed field with 400 invalid_body', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/dashboard/settings',
    headers: auth(await tokenFor('admin')),
    payload: { capacityWarningPct: 'not-a-number' },
  });
  // Body validation runs before any DB access, so this is a deterministic 400
  // even on a DB-less box.
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

test('PATCH /admin/dashboard/settings rejects an unknown key with 400 invalid_body', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/dashboard/settings',
    headers: auth(await tokenFor('admin')),
    payload: { madeUpKey: 1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});