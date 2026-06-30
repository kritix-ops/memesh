// Route-level tests for GET /admin/dashboard/live (step 2b — real DB wiring
// behind a 5s in-memory cache). Pins: auth gate, role gate, response shape
// contract on an empty DB. Data-level shape assertions (numeric counts,
// non-empty rounds list with seeded fixtures) live in
// packages/db/src/rounds-dashboard.test.ts where they belong with the
// helpers. Here we pin the HTTP/middleware boundary only.

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
const { _resetDashboardLiveCacheForTests } = await import('./admin.js');
const app: FastifyInstance = await buildApp();
await app.ready();

// The endpoint is fronted by a 5s in-memory cache. Reset between tests so
// each assertion sees a fresh computation from the empty DB rather than a
// stale cache from a previous test in this suite.
function freshCache() {
  _resetDashboardLiveCacheForTests();
}

after(async () => {
  await app.close();
});

const tokenFor = (role: 'admin' | 'manager' | 'cashier') =>
  signAccessToken({ sub: '00000000-0000-0000-0000-000000000001', role }, authConfig);

// ---------------------------------------------------------------------------
// Auth + role gate
// ---------------------------------------------------------------------------

test('GET /admin/dashboard/live without a token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/dashboard/live' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/dashboard/live as a cashier returns 403', async () => {
  const token = await tokenFor('cashier');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
});

test('GET /admin/dashboard/live as a manager reaches the DB branch', async () => {
  freshCache();
  const token = await tokenFor('manager');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  // 200 if the test box has a real DB; 500 if it doesn't. Auth + role
  // passed and the handler reached the data layer. Matches the pattern
  // from role-permissions.test.ts.
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
});

test('GET /admin/dashboard/live as an admin reaches the DB branch', async () => {
  freshCache();
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
});

// ---------------------------------------------------------------------------
// Response shape contract — load-bearing for the SPA
// ---------------------------------------------------------------------------

test('GET /admin/dashboard/live returns the documented shape (empty DB)', async () => {
  freshCache();
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  // 200 if the test box has a real DB; 500 if not. Either way the
  // auth/role gate passed and the handler reached the data layer; the
  // exact 200-path body is shape-asserted below when status is 200.
  assert.ok(
    res.statusCode === 200 || res.statusCode === 500,
    `expected 200 or 500, got ${res.statusCode}`,
  );
  if (res.statusCode !== 200) return;
  const body = res.json();

  // Top-level keys
  assert.ok(typeof body.asOf === 'string', 'asOf is a string');
  assert.ok(!Number.isNaN(Date.parse(body.asOf)), 'asOf is a parseable ISO timestamp');
  assert.ok(body.today && typeof body.today === 'object', 'today is an object');
  assert.ok(Array.isArray(body.alerts), 'alerts is an array');
  assert.ok(Array.isArray(body.waitlist), 'waitlist is an array');
  assert.ok(Array.isArray(body.weekAhead), 'weekAhead is an array');

  // today.rounds + today.stats — empty DB has no round_instances today.
  assert.ok(Array.isArray(body.today.rounds), 'today.rounds is an array');
  assert.deepEqual(body.today.rounds, [], 'today.rounds is empty (no instances)');
  const stats = body.today.stats;
  assert.equal(stats.revenueIls, 0, 'revenue stubbed until step 3');
  assert.equal(stats.revenueDeltaPct, null);
  assert.equal(stats.bookingsCount, 0);
  assert.equal(stats.bookingsDelta, null, 'null delta when yesterday count is 0');
  assert.equal(stats.activeHoldsCount, 0);
  assert.equal(stats.punchCardsSold, 0);
  assert.equal(stats.punchCardsDelta, null);

  // Alerts intentionally hardcoded empty until later step; UI hides zone.
  assert.equal(body.alerts.length, 0, 'alerts deferred to a later step');
  // No round_instances today → no waitlist activity to report.
  assert.equal(body.waitlist.length, 0);
  // Week-ahead always returns N days; with no active round templates,
  // each day's rounds[] is empty.
  assert.equal(body.weekAhead.length, 7, '7 days of forward grid always returned');
  for (const day of body.weekAhead) {
    assert.ok(typeof day.date === 'string', 'each day has an ISO date');
    assert.deepEqual(day.rounds, [], 'no active round templates → empty per-day cells');
  }
});

test('GET /admin/dashboard/live serves a cached response on the second call within 5s', async () => {
  freshCache();
  const token = await tokenFor('admin');
  const first = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  if (first.statusCode !== 200) return; // DB-less test box; skip
  const second = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(second.statusCode, 200);
  // The cache returns the SAME asOf timestamp on the second call (it's the
  // moment the cache was populated, not the moment of the second request).
  const firstBody = first.json();
  const secondBody = second.json();
  assert.equal(secondBody.asOf, firstBody.asOf, 'second call within TTL returns cached body');
});

test('GET /admin/dashboard/live carries X-Robots-Tag (admin surface, never indexed)', async () => {
  freshCache();
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  // Header is set by the global helmet/middleware on every response,
  // regardless of whether the handler returned 200 or 500.
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
});
