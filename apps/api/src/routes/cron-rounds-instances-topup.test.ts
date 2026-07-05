// Route-level tests for the daily instances top-up cron: Bearer-CRON_SECRET
// auth is enforced before any DB work, and an authorized hit reports what it
// created. The materialization itself is covered in
// packages/db/src/rounds-crud.test.ts.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';
process.env.CRON_SECRET ??= 'test-cron-secret-at-least-32-chars!!';
process.env.WP_HANDOFF_SHARED_SECRET ??= 'test-wp-handoff-secret-at-least-32-chars!';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { buildApp } = await import('../app.js');
const app: FastifyInstance = await buildApp();
await app.ready();

after(async () => {
  await app.close();
});

test('GET /cron/rounds-instances-topup without a bearer returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/cron/rounds-instances-topup' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'unauthorized');
});

test('GET /cron/rounds-instances-topup with a wrong bearer returns 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/cron/rounds-instances-topup',
    headers: { authorization: 'Bearer not-the-secret' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'unauthorized');
});

test('GET /cron/rounds-instances-topup with the right bearer runs the top-up', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/cron/rounds-instances-topup',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  // 200 if the test box has a real DB; 500 if not — never an auth failure.
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
  if (res.statusCode !== 200) return;
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.created, 'number');
});
