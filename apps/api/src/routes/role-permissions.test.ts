// Thin route-level tests for /role-permissions/*. The deep behavior (matrix
// shape, default seeding, upsert, admin lock, reset to defaults) is covered
// against PGlite in packages/db/src/role-permissions.test.ts. Here we pin the
// HTTP boilerplate: auth, role gating, body validation, lock semantics.
// Anything that needs a live DB on the API side intentionally relaxes its
// assertion to "reached the DB branch" (any 2xx/4xx/5xx other than 401/403)
// the same way wc-handoff.test.ts does for its 409/500 customer-lookup path.

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

// ---------------------------------------------------------------------------
// GET /role-permissions
// ---------------------------------------------------------------------------

test('GET /role-permissions without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/role-permissions' });
  assert.equal(res.statusCode, 401);
});

test('GET /role-permissions as a cashier returns 403', async () => {
  const token = await tokenFor('cashier');
  const res = await app.inject({
    method: 'GET',
    url: '/role-permissions',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
});

test('GET /role-permissions as a manager reaches the DB branch', async () => {
  const token = await tokenFor('manager');
  const res = await app.inject({
    method: 'GET',
    url: '/role-permissions',
    headers: { authorization: `Bearer ${token}` },
  });
  // 200 if the test box has a real DB; 500 if it doesn't. The contract we
  // pin here is "auth + role passed and the handler reached the DB query".
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
});

// ---------------------------------------------------------------------------
// PUT /role-permissions/:role/:permission — validation paths (no DB needed)
// ---------------------------------------------------------------------------

test('PUT /role-permissions without a token returns 401', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/role-permissions/cashier/cards.cancel',
    payload: { granted: true },
  });
  assert.equal(res.statusCode, 401);
});

test('PUT /role-permissions as a manager returns 403', async () => {
  const token = await tokenFor('manager');
  const res = await app.inject({
    method: 'PUT',
    url: '/role-permissions/cashier/cards.cancel',
    headers: { authorization: `Bearer ${token}` },
    payload: { granted: true },
  });
  assert.equal(res.statusCode, 403);
});

test('PUT /role-permissions/admin/* is locked with 409 admin_locked', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'PUT',
    url: '/role-permissions/admin/staff.delete',
    headers: { authorization: `Bearer ${token}` },
    payload: { granted: false },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'admin_locked');
});

test('PUT /role-permissions with an unknown permission returns 400 unknown_permission', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'PUT',
    url: '/role-permissions/cashier/totally.fake',
    headers: { authorization: `Bearer ${token}` },
    payload: { granted: true },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'unknown_permission');
});

test('PUT /role-permissions with an unknown role returns 400 invalid_role', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'PUT',
    url: '/role-permissions/superuser/cards.cancel',
    headers: { authorization: `Bearer ${token}` },
    payload: { granted: true },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_role');
});

test('PUT /role-permissions with a non-boolean granted returns 400 invalid_body', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'PUT',
    url: '/role-permissions/cashier/cards.cancel',
    headers: { authorization: `Bearer ${token}` },
    payload: { granted: 'yes' as unknown as boolean },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

// ---------------------------------------------------------------------------
// POST /role-permissions/:role/reset
// ---------------------------------------------------------------------------

test('POST /role-permissions/:role/reset without a token returns 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/role-permissions/cashier/reset',
  });
  assert.equal(res.statusCode, 401);
});

test('POST /role-permissions/:role/reset as a manager returns 403', async () => {
  const token = await tokenFor('manager');
  const res = await app.inject({
    method: 'POST',
    url: '/role-permissions/cashier/reset',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
});

test('POST /role-permissions/admin/reset is locked with 409', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'POST',
    url: '/role-permissions/admin/reset',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'admin_locked');
});

test('POST /role-permissions with an unknown role returns 400', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'POST',
    url: '/role-permissions/superuser/reset',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 400);
});
