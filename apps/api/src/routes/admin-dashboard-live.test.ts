// Route-level tests for GET /admin/dashboard/live (step 1 scaffold).
// Pins: auth gate, role gate, response shape contract. The endpoint returns
// stubbed empty data in this PR — step 2 wires real DB queries and adds
// data-level assertions. Shape is the load-bearing contract for the SPA.

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

test('GET /admin/dashboard/live as a manager returns 200', async () => {
  const token = await tokenFor('manager');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
});

test('GET /admin/dashboard/live as an admin returns 200', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------------------
// Response shape contract — load-bearing for the SPA
// ---------------------------------------------------------------------------

test('GET /admin/dashboard/live returns the documented shape (stubbed empty)', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // Top-level keys
  assert.ok(typeof body.asOf === 'string', 'asOf is a string');
  assert.ok(!Number.isNaN(Date.parse(body.asOf)), 'asOf is a parseable ISO timestamp');
  assert.ok(body.today && typeof body.today === 'object', 'today is an object');
  assert.ok(Array.isArray(body.alerts), 'alerts is an array');
  assert.ok(Array.isArray(body.waitlist), 'waitlist is an array');
  assert.ok(Array.isArray(body.weekAhead), 'weekAhead is an array');

  // today.rounds + today.stats
  assert.ok(Array.isArray(body.today.rounds), 'today.rounds is an array');
  assert.deepEqual(body.today.rounds, [], 'today.rounds is empty in the stub');
  const stats = body.today.stats;
  assert.equal(stats.revenueIls, 0);
  assert.equal(stats.revenueDeltaPct, null);
  assert.equal(stats.bookingsCount, 0);
  assert.equal(stats.bookingsDelta, null);
  assert.equal(stats.activeHoldsCount, 0);
  assert.equal(stats.punchCardsSold, 0);
  assert.equal(stats.punchCardsDelta, null);

  // Empty zones are empty arrays, not null — the UI hides the zone on .length === 0.
  assert.equal(body.alerts.length, 0);
  assert.equal(body.waitlist.length, 0);
  assert.equal(body.weekAhead.length, 0);
});

test('GET /admin/dashboard/live carries X-Robots-Tag (admin surface, never indexed)', async () => {
  const token = await tokenFor('admin');
  const res = await app.inject({
    method: 'GET',
    url: '/admin/dashboard/live',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
});
