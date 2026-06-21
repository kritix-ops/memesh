// Provide the env config needs before app.ts (which imports config) loads.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

// Dynamic import so the env above is set before config.ts parses it.
const { buildApp } = await import('./app.js');
const app: FastifyInstance = await buildApp();
await app.ready();

after(async () => {
  await app.close();
});

test('GET /health returns ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('POST /auth/login rejects an invalid body with 400', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { phone: '' } });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/login rejects a missing email with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { password: 'whatever' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/login rejects a malformed email with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'not-an-email', password: 'whatever' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/forgot-password rejects a missing email with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/forgot-password',
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/forgot-password rejects a malformed email with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/forgot-password',
    payload: { email: 'not-an-email' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/reset-password rejects a missing token with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/reset-password',
    payload: { newPassword: 'a-fresh-strong-password' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/reset-password rejects a too-short password with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/reset-password',
    payload: { token: 'a'.repeat(40), newPassword: 'short' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /punch without auth returns 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/punch', payload: { token: 'x' } });
  assert.equal(res.statusCode, 401);
});

test('POST /customers without auth returns 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/customers', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('POST /cards without auth returns 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/cards', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('POST /auth/customer/request-otp rejects an invalid body with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/customer/request-otp',
    payload: { phone: '' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/customer/verify-otp rejects an invalid body with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/customer/verify-otp',
    payload: { phone: '052-1234567', code: 'abc' },
  });
  assert.equal(res.statusCode, 400);
});

test('GET /me/cards without a customer token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/me/cards' });
  assert.equal(res.statusCode, 401);
});

test('GET /me without a customer token returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/me' });
  assert.equal(res.statusCode, 401);
});

test('PATCH /me without a customer token returns 401', async () => {
  const res = await app.inject({ method: 'PATCH', url: '/me', payload: { firstName: 'X' } });
  assert.equal(res.statusCode, 401);
});

test('POST /staff without auth returns 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/staff', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('GET /staff without auth returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/staff' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/dashboard without auth returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/dashboard' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/reports/dormant without auth returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/reports/dormant' });
  assert.equal(res.statusCode, 401);
});

test('GET /customers/:id without auth returns 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/customers/00000000-0000-0000-0000-000000000000',
  });
  assert.equal(res.statusCode, 401);
});

test('POST /cards/:id/cancel without auth returns 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/cards/00000000-0000-0000-0000-000000000000/cancel',
    payload: { reason: 'x' },
  });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/actions without auth returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/actions' });
  assert.equal(res.statusCode, 401);
});

test('GET /cards without auth returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/cards?status=active' });
  assert.equal(res.statusCode, 401);
});

test('GET /cards/:id without auth returns 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/cards/00000000-0000-0000-0000-000000000000',
  });
  assert.equal(res.statusCode, 401);
});

test('PATCH /staff/:id without auth returns 401', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/staff/00000000-0000-0000-0000-000000000000',
    payload: { firstName: 'X' },
  });
  assert.equal(res.statusCode, 401);
});

test('DELETE /staff/:id without auth returns 401', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/staff/00000000-0000-0000-0000-000000000000',
  });
  assert.equal(res.statusCode, 401);
});

test('DELETE /customers/:id without auth returns 401', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/customers/00000000-0000-0000-0000-000000000000',
  });
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// /webhooks/woocommerce/order — structural HTTP gates only. The full
// processor flow is covered in src/lib/wc-order-processor.test.ts against
// PGlite. These tests just confirm the route refuses traffic that doesn't
// look like a signed WC delivery.
// ---------------------------------------------------------------------------

test('GET /webhooks/woocommerce/health returns ok (smoke endpoint)', async () => {
  const res = await app.inject({ method: 'GET', url: '/webhooks/woocommerce/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('POST /webhooks/woocommerce/order without headers returns 503 in tests (no WC_WEBHOOK_SECRET)', async () => {
  // WC_WEBHOOK_SECRET is intentionally unset in the test env, so the route
  // hits the production guard first and 503s. Once the secret is set,
  // missing headers move the response to 401 — covered manually + by the
  // processor tests indirectly.
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/woocommerce/order',
    payload: { id: 1, status: 'completed', line_items: [] },
  });
  assert.equal(res.statusCode, 503);
});

// ---------------------------------------------------------------------------
// /cron/wc-reconcile — structural HTTP gates only. The reconciliation
// pipeline itself is covered in src/lib/wc-reconciliation.test.ts.
// ---------------------------------------------------------------------------

test('GET /cron/wc-reconcile returns 503 in tests (no CRON_SECRET)', async () => {
  // CRON_SECRET is unset in the test env, so the route hits the production
  // guard before any auth comparison and 503s. With it set, missing or
  // wrong Authorization moves the response to 401.
  const res = await app.inject({ method: 'GET', url: '/cron/wc-reconcile' });
  assert.equal(res.statusCode, 503);
});

test('GET /cron/wc-reconcile rejects POST (Vercel Cron uses GET)', async () => {
  const res = await app.inject({ method: 'POST', url: '/cron/wc-reconcile' });
  assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Cashier PIN + email-OTP routes (Yanay 2026-06-20). Auth-gate smoke tests
// only — the underlying flow is covered by db unit tests
// (staff-pins.test.ts, email-otp.test.ts) and route behavior is exercised
// manually in QA per the plan's testing section.
// ---------------------------------------------------------------------------

test('GET /staff/:id/pin without auth returns 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/staff/00000000-0000-0000-0000-000000000000/pin',
  });
  assert.equal(res.statusCode, 401);
});

test('PUT /staff/:id/pin without auth returns 401', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/staff/00000000-0000-0000-0000-000000000000/pin',
    payload: { pin: '123' },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /staff/:id/pin/generate without auth returns 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/staff/00000000-0000-0000-0000-000000000000/pin/generate',
  });
  assert.equal(res.statusCode, 401);
});

test('DELETE /staff/:id/pin without auth returns 401', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/staff/00000000-0000-0000-0000-000000000000/pin',
  });
  assert.equal(res.statusCode, 401);
});

test('POST /staff/:id/pin/unlock without auth returns 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/staff/00000000-0000-0000-0000-000000000000/pin/unlock',
  });
  assert.equal(res.statusCode, 401);
});

test('GET /me/pin without auth returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/me/pin' });
  assert.equal(res.statusCode, 401);
});

test('PUT /me/pin without auth returns 401', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/me/pin',
    payload: { pin: '123', password: 'x' },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /auth/customer/request-email-otp rejects an invalid email with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/customer/request-email-otp',
    payload: { email: 'not-an-email' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/customer/verify-email-otp rejects an invalid body with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/customer/verify-email-otp',
    payload: { email: 'noa@example.com', code: 'abc' },
  });
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// noindex header: the API must never be search-indexable. The onSend hook in
// securityPlugin applies the X-Robots-Tag globally, so every response — 200,
// 400, 401 — carries it. We sample one of each.
// ---------------------------------------------------------------------------

test('every response carries X-Robots-Tag: noindex, nofollow (200)', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
});

test('every response carries X-Robots-Tag: noindex, nofollow (400)', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { phone: '' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
});

test('every response carries X-Robots-Tag: noindex, nofollow (401)', async () => {
  const res = await app.inject({ method: 'GET', url: '/me' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
});
