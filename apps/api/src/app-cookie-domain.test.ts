// Verifies the COOKIE_DOMAIN env var produces a Domain= attribute on every
// cookie the API sets. The env MUST be set before config.ts loads.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';
process.env.COOKIE_DOMAIN = '.memesh.co.il';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { buildApp } = await import('./app.js');
const app: FastifyInstance = await buildApp();
await app.ready();

after(async () => {
  await app.close();
});

const setCookieHeaders = (raw: string | string[] | undefined): string[] => {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
};

test('staff logout clears cookies with Domain=.memesh.co.il', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/logout' });
  assert.equal(res.statusCode, 200);
  const cookies = setCookieHeaders(res.headers['set-cookie']);
  assert.ok(cookies.length >= 2, 'expected access_token + refresh_token Set-Cookie headers');
  for (const c of cookies) {
    assert.match(c, /Domain=\.memesh\.co\.il/i, `expected Domain attribute on: ${c}`);
    assert.match(c, /Path=\//, `expected Path=/ on: ${c}`);
  }
});

test('customer logout clears the cookie with Domain=.memesh.co.il', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/customer/logout' });
  assert.equal(res.statusCode, 200);
  const cookies = setCookieHeaders(res.headers['set-cookie']);
  assert.ok(cookies.length >= 1, 'expected customer_token Set-Cookie header');
  for (const c of cookies) {
    assert.match(c, /Domain=\.memesh\.co\.il/i, `expected Domain attribute on: ${c}`);
    assert.match(c, /Path=\//, `expected Path=/ on: ${c}`);
  }
});
