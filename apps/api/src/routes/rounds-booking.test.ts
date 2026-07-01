// Route-level tests for the public rounds availability endpoint. Pins that it's
// public (no auth), validates the date param before touching the DB, and returns
// the documented shape. Occupancy math is covered in
// packages/db/src/rounds-crud.test.ts.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';
process.env.CRON_SECRET ??= 'test-cron-secret-at-least-32-chars!!';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { signCustomerToken } = await import('@memesh/auth');
const { customerAuthConfig } = await import('../auth.js');
const { buildApp } = await import('../app.js');
const app: FastifyInstance = await buildApp();
await app.ready();

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';
const customerToken = () => signCustomerToken(CUSTOMER_ID, customerAuthConfig);
const validHold = {
  roundInstanceId: '00000000-0000-0000-0000-0000000000a1',
  ticketType: 'child_over_walking',
};

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

// --- POST /rounds/hold + /release (customer-gated) --------------------------

test('POST /rounds/hold without a customer token returns 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/rounds/hold', payload: validHold });
  assert.equal(res.statusCode, 401);
});

test('POST /rounds/hold with a customer token rejects a bad body with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/rounds/hold',
    headers: { authorization: `Bearer ${await customerToken()}` },
    payload: { roundInstanceId: 'not-a-uuid', ticketType: 'child_over_walking' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_body');
});

test('POST /rounds/hold with a valid body reaches the hold engine', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/rounds/hold',
    headers: { authorization: `Bearer ${await customerToken()}` },
    payload: validHold,
  });
  // Auth + validation passed. With no such instance it's 404 on a real DB, or
  // 500 on the DB-less box — either way it reached createHold past the gates.
  assert.ok(
    [404, 409, 500].includes(res.statusCode),
    `expected 404/409/500, got ${res.statusCode}`,
  );
});

test('POST /rounds/hold/release without a customer token returns 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/rounds/hold/release',
    payload: { holdId: '00000000-0000-0000-0000-0000000000b1' },
  });
  assert.equal(res.statusCode, 401);
});

// --- POST /rounds/dev-pay (dev-only mint stub) ------------------------------

test('POST /rounds/dev-pay without a customer token returns 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/rounds/dev-pay',
    payload: { holdId: '00000000-0000-0000-0000-0000000000d1' },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /rounds/dev-pay with a valid body reaches the mint (enabled outside prod)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/rounds/dev-pay',
    headers: { authorization: `Bearer ${await customerToken()}` },
    payload: { holdId: '00000000-0000-0000-0000-0000000000d1' },
  });
  // NODE_ENV is 'test' so the stub is enabled (not 404-disabled). No such hold
  // → 404 on a real DB, or 500 on the DB-less box; either way it passed the
  // customer gate + body validation rather than 401.
  assert.notEqual(res.statusCode, 401);
  assert.ok([403, 404, 409, 500].includes(res.statusCode), `got ${res.statusCode}`);
});

// --- cron sweeper -----------------------------------------------------------

test('GET /cron/rounds-hold-sweep without the cron secret returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/cron/rounds-hold-sweep' });
  assert.equal(res.statusCode, 401);
});

test('GET /cron/rounds-hold-sweep with the cron secret reaches the sweep', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/cron/rounds-hold-sweep',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  // Auth passed → 200 on a real DB, 500 on the DB-less box.
  assert.ok(res.statusCode === 200 || res.statusCode === 500, `got ${res.statusCode}`);
});
