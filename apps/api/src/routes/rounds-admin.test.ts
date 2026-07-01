// Route-level tests for the admin rounds management endpoints. Pins the
// admin-only gate and the pre-DB body validation. Business rules (times,
// capacity, materialization) are covered in packages/db/src/rounds-crud.test.ts.

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

const validBody = {
  label: 'afternoon',
  displayName: 'סבב אחר הצהריים',
  startTime: '16:00',
  endTime: '18:00',
  daysActive: 127,
  defaultCapacity: 50,
};

// --- role gate --------------------------------------------------------------

test('GET /admin/rounds without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/rounds' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/rounds as a manager returns 403 (admin-only)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/rounds',
    headers: auth(await tokenFor('manager')),
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/rounds as an admin reaches the DB branch', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/rounds',
    headers: auth(await tokenFor('admin')),
  });
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
  if (res.statusCode !== 200) return;
  assert.ok(Array.isArray(res.json().rounds), 'rounds is an array');
});

test('POST /admin/rounds as a cashier returns 403', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/rounds',
    headers: auth(await tokenFor('cashier')),
    payload: validBody,
  });
  assert.equal(res.statusCode, 403);
});

// --- body validation (pre-DB → deterministic) -------------------------------

test('POST /admin/rounds rejects a missing field with 400 invalid_body', async () => {
  const { defaultCapacity: _omit, ...missing } = validBody;
  const res = await app.inject({
    method: 'POST',
    url: '/admin/rounds',
    headers: auth(await tokenFor('admin')),
    payload: missing,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

test('POST /admin/rounds rejects a wrong-typed field with 400 invalid_body', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/rounds',
    headers: auth(await tokenFor('admin')),
    payload: { ...validBody, daysActive: 'all' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

test('PATCH /admin/rounds/:id rejects an empty body with 400 invalid_body', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/rounds/00000000-0000-0000-0000-000000000000',
    headers: auth(await tokenFor('admin')),
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

test('PATCH /admin/rounds/:id rejects an unknown key with 400 invalid_body', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/rounds/00000000-0000-0000-0000-000000000000',
    headers: auth(await tokenFor('admin')),
    payload: { madeUp: 1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

// --- delete / duplicate / schedule rules (Yoav 2026-07-02) --------------------

test('DELETE /admin/rounds/:id is admin-only', async () => {
  const noToken = await app.inject({
    method: 'DELETE',
    url: '/admin/rounds/00000000-0000-0000-0000-000000000000',
  });
  assert.equal(noToken.statusCode, 401);

  const manager = await app.inject({
    method: 'DELETE',
    url: '/admin/rounds/00000000-0000-0000-0000-000000000000',
    headers: auth(await tokenFor('manager')),
  });
  assert.equal(manager.statusCode, 403);
});

test('DELETE /admin/rounds/:id as admin reaches the DB branch (404 on unknown id)', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/admin/rounds/00000000-0000-0000-0000-000000000000',
    headers: auth(await tokenFor('admin')),
  });
  assert.ok([404, 409, 500].includes(res.statusCode), `got ${res.statusCode}`);
});

test('POST /admin/rounds/:id/duplicate is admin-only and reaches the DB branch', async () => {
  const manager = await app.inject({
    method: 'POST',
    url: '/admin/rounds/00000000-0000-0000-0000-000000000000/duplicate',
    headers: auth(await tokenFor('manager')),
  });
  assert.equal(manager.statusCode, 403);

  const admin = await app.inject({
    method: 'POST',
    url: '/admin/rounds/00000000-0000-0000-0000-000000000000/duplicate',
    headers: auth(await tokenFor('admin')),
  });
  assert.ok([404, 500].includes(admin.statusCode), `got ${admin.statusCode}`);
});

test('schedule-rules: admin-only gates and body validation', async () => {
  const noToken = await app.inject({ method: 'GET', url: '/admin/rounds/schedule-rules' });
  assert.equal(noToken.statusCode, 401);

  const manager = await app.inject({
    method: 'GET',
    url: '/admin/rounds/schedule-rules',
    headers: auth(await tokenFor('manager')),
  });
  assert.equal(manager.statusCode, 403);

  const badShape = await app.inject({
    method: 'POST',
    url: '/admin/rounds/schedule-rules',
    headers: auth(await tokenFor('admin')),
    payload: { windows: 'nope', outside: 'free_play' },
  });
  assert.equal(badShape.statusCode, 400);

  // Shape-valid but scopeless — the DB-layer validator rejects before any
  // DB write, so this is a clean 400 even on the DB-less test box.
  const scopeless = await app.inject({
    method: 'POST',
    url: '/admin/rounds/schedule-rules',
    headers: auth(await tokenFor('admin')),
    payload: { windows: [], outside: 'free_play' },
  });
  assert.equal(scopeless.statusCode, 400);
  assert.equal(scopeless.json().error, 'scope_required');
});
