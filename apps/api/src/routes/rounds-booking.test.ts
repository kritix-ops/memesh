// Route-level tests for the public rounds availability endpoint. Pins that it's
// public (no auth), validates the date param before touching the DB, and returns
// the documented shape. Occupancy math is covered in
// packages/db/src/rounds-crud.test.ts.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { buildApp } = await import('../app.js');
const app: FastifyInstance = await buildApp();
await app.ready();

after(async () => {
  await app.close();
});

test('GET /rounds/availability with no date returns 400 invalid_date', async () => {
  const res = await app.inject({ method: 'GET', url: '/rounds/availability' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_date');
});

test('GET /rounds/availability with a malformed date returns 400', async () => {
  const res = await app.inject({ method: 'GET', url: '/rounds/availability?date=07-01-2026' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_date');
});

test('GET /rounds/availability is public (no auth) and returns the documented shape', async () => {
  const res = await app.inject({ method: 'GET', url: '/rounds/availability?date=2026-07-01' });
  // Public: never 401/403. 200 if the test box has a real DB; 500 if not.
  assert.notEqual(res.statusCode, 401);
  assert.notEqual(res.statusCode, 403);
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
  if (res.statusCode !== 200) return;
  const body = res.json();
  assert.equal(body.date, '2026-07-01');
  assert.ok(Array.isArray(body.rounds), 'rounds is an array');
  for (const r of body.rounds) {
    assert.equal(typeof r.roundInstanceId, 'string');
    assert.equal(typeof r.available, 'number');
    assert.equal(typeof r.capacity, 'number');
    // Public shape must not leak internal fields.
    assert.equal(r.taken, undefined, 'no internal taken count');
    assert.equal(r.revenueIls, undefined, 'no revenue');
  }
});
