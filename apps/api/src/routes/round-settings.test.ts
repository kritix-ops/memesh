// Route-level tests for the rounds operational settings surface:
//   GET   /admin/round-settings  (admin-only read of the singleton)
//   PATCH /admin/round-settings  (admin-only partial update)
// Pins the auth + role gate and pre-DB body validation; range/format validation
// is exercised in packages/db/src/round-settings.test.ts.

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

test('GET /admin/round-settings without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/round-settings' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/round-settings as a manager returns 403 (admin-only)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/round-settings',
    headers: auth(await tokenFor('manager')),
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/round-settings as an admin reaches the DB branch', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/round-settings',
    headers: auth(await tokenFor('admin')),
  });
  assert.ok(res.statusCode === 200 || res.statusCode === 500, `got ${res.statusCode}`);
  if (res.statusCode !== 200) return;
  const body = res.json();
  assert.equal(typeof body.settings.holdTtlMinutes, 'number');
  assert.ok(Array.isArray(body.settings.reminderOffsets), 'reminderOffsets is an array');
});

test('PATCH /admin/round-settings without a token returns 401', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/round-settings',
    payload: { skipLastRoundReminder: false },
  });
  assert.equal(res.statusCode, 401);
});

test('PATCH /admin/round-settings as a manager returns 403 (admin-only)', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/round-settings',
    headers: auth(await tokenFor('manager')),
    payload: { skipLastRoundReminder: false },
  });
  assert.equal(res.statusCode, 403);
});

test('PATCH /admin/round-settings rejects a wrong-typed field with 400 invalid_body', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/round-settings',
    headers: auth(await tokenFor('admin')),
    payload: { holdTtlMinutes: 'not-a-number' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

test('PATCH /admin/round-settings rejects an unknown key with 400 invalid_body', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/admin/round-settings',
    headers: auth(await tokenFor('admin')),
    payload: { madeUpKey: 1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

// Field-forwarding is unit-tested here (no DB) because the route harness has no
// Postgres. Persistence itself is covered in packages/db/src/round-settings.test.ts.
test('buildRoundSettingsPatch forwards the #115 notification toggles (audit blocker #2)', async () => {
  const { buildRoundSettingsPatch } = await import('./round-settings.js');
  const patch = buildRoundSettingsPatch({
    preVisitReminderOffsets: [1440],
    bookingConfirmEmail: false, // a false value must still be forwarded, not dropped
    bookingConfirmSms: true,
  });
  assert.deepEqual(patch.preVisitReminderOffsets, [1440]);
  assert.equal(patch.bookingConfirmEmail, false);
  assert.equal(patch.bookingConfirmSms, true);
});

test('buildRoundSettingsPatch omits keys the caller did not send (no clobber)', async () => {
  const { buildRoundSettingsPatch } = await import('./round-settings.js');
  const patch = buildRoundSettingsPatch({ holdTtlMinutes: 20 });
  assert.deepEqual(Object.keys(patch), ['holdTtlMinutes']);
  assert.equal('bookingConfirmSms' in patch, false);
});
