// Set env BEFORE config.ts loads. With CORS_ALLOWED_ORIGINS populated and
// NODE_ENV pinned to 'test' (so the non-development branch in app.ts kicks
// in), the CORS plugin builds its allowlist from these values.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';
process.env.CORS_ALLOWED_ORIGINS =
  'https://staff.memesh.co.il,https://admin.memesh.co.il,https://my.memesh.co.il';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const { buildApp } = await import('./app.js');
const app: FastifyInstance = await buildApp();
await app.ready();

after(async () => {
  await app.close();
});

// CORS preflight from each allowed frontend gets mirrored on
// Access-Control-Allow-Origin, with Allow-Credentials:true so the browser
// includes cookies on the eventual real request.

test('OPTIONS from staff.memesh.co.il is allowed and credentials enabled', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/auth/me',
    headers: {
      origin: 'https://staff.memesh.co.il',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(res.headers['access-control-allow-origin'], 'https://staff.memesh.co.il');
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
});

test('OPTIONS from admin.memesh.co.il is allowed', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/admin/dashboard',
    headers: {
      origin: 'https://admin.memesh.co.il',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(res.headers['access-control-allow-origin'], 'https://admin.memesh.co.il');
});

test('OPTIONS from my.memesh.co.il is allowed', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/me',
    headers: {
      origin: 'https://my.memesh.co.il',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(res.headers['access-control-allow-origin'], 'https://my.memesh.co.il');
});

test('OPTIONS from an unknown origin gets NO Allow-Origin header (rejected)', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/auth/me',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'GET',
    },
  });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('Allow-Origin is never the wildcard (incompatible with credentials:true)', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/auth/me',
    headers: {
      origin: 'https://staff.memesh.co.il',
      'access-control-request-method': 'GET',
    },
  });
  assert.notEqual(res.headers['access-control-allow-origin'], '*');
});
