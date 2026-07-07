// Route-level tests for the holiday-closures admin endpoints: the admin-only
// gate and pre-DB/pre-network body validation. The sync + calendar + policy
// logic is covered in src/lib/holiday-sync.test.ts and
// packages/db/src/holiday-policies.test.ts.

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

test('GET /admin/holidays without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/holidays' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/holidays as a manager returns 403 (admin-only)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/holidays',
    headers: auth(await tokenFor('manager')),
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/holidays with a non-numeric year returns 400 before any fetch', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/holidays?year=banana',
    headers: auth(await tokenFor('admin')),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_year');
});

test('PATCH /admin/holidays/:key with only a year (no change) returns 400', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/holidays/yom_kippur',
    headers: auth(await tokenFor('admin')),
    payload: { year: 2026 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

test('POST /admin/holidays/sync as a cashier returns 403', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/holidays/sync?year=2026',
    headers: auth(await tokenFor('cashier')),
  });
  assert.equal(res.statusCode, 403);
});
