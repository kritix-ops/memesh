// Route-level tests for the editable-content surface:
//   GET   /content            (public read of the merged map)
//   GET   /admin/content      (admin-only read of the overrides)
//   PATCH /admin/content      (admin-only edit)
// Pins the auth/role gate and the validation-error mapping. Because the DB
// helper validates keys + placeholders BEFORE touching the DB, the rejection
// cases are deterministic without a live database; merge behaviour itself is
// exercised in packages/db/src/content-overrides.test.ts.

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

test('GET /content is public and reaches the DB branch', async () => {
  const res = await app.inject({ method: 'GET', url: '/content' });
  assert.ok(res.statusCode === 200 || res.statusCode === 500, `got ${res.statusCode}`);
  if (res.statusCode !== 200) return;
  assert.equal(typeof res.json().content, 'object');
});

test('GET /admin/content is admin-only', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/admin/content' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/admin/content',
        headers: auth(await tokenFor('manager')),
      })
    ).statusCode,
    403,
  );
});

test('PATCH /admin/content is admin-only', async () => {
  assert.equal(
    (await app.inject({ method: 'PATCH', url: '/admin/content', payload: { patch: {} } }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: '/admin/content',
        headers: auth(await tokenFor('manager')),
        payload: { patch: {} },
      })
    ).statusCode,
    403,
  );
});

test('PATCH /admin/content rejects a malformed body with 400 invalid_body', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/content',
    headers: auth(await tokenFor('admin')),
    payload: { patch: 'not-an-object' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

test('PATCH /admin/content maps an unknown key to 400 (pre-DB, deterministic)', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/content',
    headers: auth(await tokenFor('admin')),
    payload: { patch: { 'no.such.key': 'x' } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'unknown_key');
});

test('PATCH /admin/content maps an unknown placeholder to 400 (pre-DB, deterministic)', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/content',
    headers: auth(await tokenFor('admin')),
    payload: { patch: { 'customer.policy.cancel': 'עד {{foo}} שעות' } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'unknown_placeholder');
});
