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
