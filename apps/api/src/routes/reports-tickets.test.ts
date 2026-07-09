// Route-level tests for GET /admin/reports/tickets — the cross-round tickets
// (bookings) read feeding ניהול כרטיסים and the דוחות section. Pins the auth +
// role gate and the query validation; data-level assertions live with the DB
// helper (packages/db/src/tickets-report.test.ts).

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

test('GET /admin/reports/tickets without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/reports/tickets' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/reports/tickets as a cashier returns 403 (manager/admin only)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/reports/tickets',
    headers: auth(await tokenFor('cashier')),
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/reports/tickets rejects malformed queries with 400', async () => {
  const token = await tokenFor('admin');
  const bad = [
    'status=held', // held is deliberately not a queryable status
    'status=nope',
    'source=cash',
    'ticketType=adult',
    'dateFrom=11-07-2026',
    'dateTo=2026-7-1',
    'limit=0',
    'limit=1001',
    'offset=-1',
    'sort=phone',
    'sortDir=up',
    'q=' + 'x'.repeat(121),
  ];
  for (const qs of bad) {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/reports/tickets?${qs}`,
      headers: auth(token),
    });
    assert.equal(res.statusCode, 400, `expected 400 for ?${qs}, got ${res.statusCode}`);
    assert.equal(res.json().error, 'invalid_query');
  }
});

test('GET /admin/reports/tickets passes the gate for manager and admin', async () => {
  for (const role of ['manager', 'admin'] as const) {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/reports/tickets?status=confirmed&source=punchcard&dateFrom=2026-07-01&dateTo=2026-07-31&limit=50&offset=0&sort=date&sortDir=desc&q=noa',
      headers: auth(await tokenFor(role)),
    });
    // 200 with a real DB behind the test box; 500 without one. Either way the
    // auth + role + validation layers passed.
    assert.ok(
      res.statusCode === 200 || res.statusCode === 500,
      `expected 200 or 500 for ${role}, got ${res.statusCode}`,
    );
    if (res.statusCode !== 200) continue;
    const body = res.json();
    assert.ok(Array.isArray(body.rows));
    assert.equal(typeof body.total, 'number');
    assert.ok(body.summary && typeof body.summary === 'object');
    for (const k of ['confirmed', 'used', 'cancelled', 'expired', 'companions']) {
      assert.equal(typeof body.summary[k], 'number', `summary.${k} is a number`);
    }
  }
});
