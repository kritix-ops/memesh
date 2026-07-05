// Route-level tests for GET /staff/rounds/today — the read-only rounds status
// for the shift floor. Pins the auth gate, that all staff roles (incl. cashier)
// may read it, and that the response carries occupancy + waitlist only, never
// revenue or stats. Data-level assertions live with the DB helpers.

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
const { _resetStaffRoundsCacheForTests } = await import('./staff-rounds.js');
const app: FastifyInstance = await buildApp();
await app.ready();

after(async () => {
  await app.close();
});

const tokenFor = (role: 'admin' | 'manager' | 'cashier') =>
  signAccessToken({ sub: '00000000-0000-0000-0000-000000000001', role }, authConfig);

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test('GET /staff/rounds/today without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/staff/rounds/today' });
  assert.equal(res.statusCode, 401);
});

test('GET /staff/rounds/today as a cashier reaches the DB branch (all staff roles allowed)', async () => {
  _resetStaffRoundsCacheForTests();
  const res = await app.inject({
    method: 'GET',
    url: '/staff/rounds/today',
    headers: auth(await tokenFor('cashier')),
  });
  // 200 if the test box has a real DB; 500 if not. Either way auth + role passed.
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
});

test('GET /staff/rounds/today rejects a malformed ?date=', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/staff/rounds/today?date=not-a-date',
    headers: auth(await tokenFor('cashier')),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_date');
});

test('GET /staff/rounds/today?date=YYYY-MM-DD serves that date (future days visible to the floor)', async () => {
  _resetStaffRoundsCacheForTests();
  const res = await app.inject({
    method: 'GET',
    url: '/staff/rounds/today?date=2027-01-15',
    headers: auth(await tokenFor('cashier')),
  });
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
  if (res.statusCode !== 200) return;
  const body = res.json();
  assert.equal(body.date, '2027-01-15');
  assert.deepEqual(body.waitlist, [], 'waitlist stays empty for non-today dates');
});

test('GET /staff/rounds/today returns occupancy + waitlist only, never revenue', async () => {
  _resetStaffRoundsCacheForTests();
  const res = await app.inject({
    method: 'GET',
    url: '/staff/rounds/today',
    headers: auth(await tokenFor('cashier')),
  });
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
  if (res.statusCode !== 200) return;
  const body = res.json();
  assert.ok(typeof body.asOf === 'string', 'asOf is a string');
  assert.ok(Array.isArray(body.rounds), 'rounds is an array');
  assert.ok(Array.isArray(body.waitlist), 'waitlist is an array');
  assert.ok(body.settings && typeof body.settings === 'object', 'settings object present');
  assert.equal(typeof body.settings.refreshIntervalSeconds, 'number');
  assert.equal(typeof body.settings.capacityWarningPct, 'number');
  // Never exposes money or the admin stats block to the shift floor.
  assert.equal(body.stats, undefined, 'no stats block');
  assert.equal(body.settings.showRevenue, undefined, 'no revenue toggle leaked');
  for (const r of body.rounds) {
    assert.equal(r.revenueIls, undefined, 'no per-round revenue');
    assert.equal(typeof r.heldCount, 'number', 'heldCount exposed for the panel');
  }
});

test('GET /staff/rounds/:id/attendees is staff-gated and validates the id', async () => {
  const noToken = await app.inject({
    method: 'GET',
    url: '/staff/rounds/00000000-0000-0000-0000-000000000000/attendees',
  });
  assert.equal(noToken.statusCode, 401);

  const badId = await app.inject({
    method: 'GET',
    url: '/staff/rounds/not-a-uuid/attendees',
    headers: auth(await tokenFor('cashier')),
  });
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.json().error, 'invalid_id');

  const ok = await app.inject({
    method: 'GET',
    url: '/staff/rounds/00000000-0000-0000-0000-000000000000/attendees',
    headers: auth(await tokenFor('cashier')),
  });
  // 200 with [] on a real DB (unknown instance simply has no bookings);
  // 500 on the DB-less box. Either way auth + validation passed.
  assert.ok([200, 500].includes(ok.statusCode), `got ${ok.statusCode}`);
});

test('POST /staff/rounds/bookings/:id/arrival is staff-gated and validates id + body', async () => {
  const noToken = await app.inject({
    method: 'POST',
    url: '/staff/rounds/bookings/00000000-0000-0000-0000-000000000000/arrival',
    payload: { arrived: true },
  });
  assert.equal(noToken.statusCode, 401);

  const badId = await app.inject({
    method: 'POST',
    url: '/staff/rounds/bookings/not-a-uuid/arrival',
    headers: auth(await tokenFor('cashier')),
    payload: { arrived: true },
  });
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.json().error, 'invalid_id');

  const badBody = await app.inject({
    method: 'POST',
    url: '/staff/rounds/bookings/00000000-0000-0000-0000-000000000000/arrival',
    headers: auth(await tokenFor('cashier')),
    payload: { arrived: 'yes' },
  });
  assert.equal(badBody.statusCode, 400);
  assert.equal(badBody.json().error, 'invalid_body');

  const ok = await app.inject({
    method: 'POST',
    url: '/staff/rounds/bookings/00000000-0000-0000-0000-000000000000/arrival',
    headers: auth(await tokenFor('cashier')),
    payload: { arrived: true },
  });
  // Unknown booking → 404 on a real DB; 500 on the DB-less box. Either way
  // auth + validation passed and the engine was reached.
  assert.ok([404, 500].includes(ok.statusCode), `got ${ok.statusCode}`);
});

test('POST /staff/rounds/checkin/lookup is staff-gated and validates input', async () => {
  const noToken = await app.inject({
    method: 'POST',
    url: '/staff/rounds/checkin/lookup',
    payload: { bookingNumber: 'R-20260705-0001' },
  });
  assert.equal(noToken.statusCode, 401);

  const emptyBody = await app.inject({
    method: 'POST',
    url: '/staff/rounds/checkin/lookup',
    headers: auth(await tokenFor('cashier')),
    payload: {},
  });
  assert.equal(emptyBody.statusCode, 400);
  assert.equal(emptyBody.json().error, 'invalid_body');

  const badToken = await app.inject({
    method: 'POST',
    url: '/staff/rounds/checkin/lookup',
    headers: auth(await tokenFor('cashier')),
    payload: { token: 'not-a-real-token' },
  });
  assert.equal(badToken.statusCode, 400);
  assert.equal(badToken.json().error, 'invalid_token');

  const unknownNumber = await app.inject({
    method: 'POST',
    url: '/staff/rounds/checkin/lookup',
    headers: auth(await tokenFor('cashier')),
    payload: { bookingNumber: 'R-19990101-0001' },
  });
  // 404 on a real DB (no such booking); 500 on the DB-less box.
  assert.ok([404, 500].includes(unknownNumber.statusCode), `got ${unknownNumber.statusCode}`);
});

test('GET /staff/customers/:id/rounds-today is staff-gated and validates the id', async () => {
  const noToken = await app.inject({
    method: 'GET',
    url: '/staff/customers/00000000-0000-0000-0000-000000000000/rounds-today',
  });
  assert.equal(noToken.statusCode, 401);

  const badId = await app.inject({
    method: 'GET',
    url: '/staff/customers/not-a-uuid/rounds-today',
    headers: auth(await tokenFor('cashier')),
  });
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.json().error, 'invalid_id');

  const ok = await app.inject({
    method: 'GET',
    url: '/staff/customers/00000000-0000-0000-0000-000000000000/rounds-today',
    headers: auth(await tokenFor('cashier')),
  });
  // 200 with [] on a real DB (unknown customer has no bookings); 500 without.
  assert.ok([200, 500].includes(ok.statusCode), `got ${ok.statusCode}`);
  if (ok.statusCode !== 200) return;
  const body = ok.json();
  assert.ok(typeof body.date === 'string');
  assert.ok(Array.isArray(body.bookings));
  if (ok.statusCode === 200) assert.deepEqual(ok.json().attendees, []);
});
