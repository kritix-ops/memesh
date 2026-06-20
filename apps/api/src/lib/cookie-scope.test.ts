// Importing cookie-scope.ts pulls in config.ts (for the env-coupled wrappers),
// which validates process.env at module load. Provide the minimum env so the
// file loads — the actual values don't matter for the pure-helper tests.
// ESM hoists static imports above top-level statements, so cookie-scope.ts
// must be brought in via dynamic import AFTER the env defaults are set.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { clearCookieScopeFor, cookieScopeFor } = await import('./cookie-scope.js');

// Pure-helper tests. The env-coupled cookieScope()/clearCookieScope() wrappers
// are exercised indirectly by the auth + customer-auth integration tests; this
// file pins down the rules that wrapper depends on.

test('cookieScopeFor: dev (isProd:false) → no Secure, no Domain', () => {
  const s = cookieScopeFor({ isProd: false });
  assert.equal(s.httpOnly, true);
  assert.equal(s.secure, false);
  assert.equal(s.sameSite, 'lax');
  assert.equal(s.path, '/');
  assert.equal(s.domain, undefined);
});

test('cookieScopeFor: prod, no domain → Secure but no Domain', () => {
  const s = cookieScopeFor({ isProd: true });
  assert.equal(s.secure, true);
  assert.equal(s.domain, undefined);
});

test('cookieScopeFor: prod with split-subdomain domain → Secure + Domain', () => {
  const s = cookieScopeFor({ isProd: true, domain: '.memesh.co.il' });
  assert.equal(s.secure, true);
  assert.equal(s.domain, '.memesh.co.il');
});

test('cookieScopeFor: empty-string domain is treated as "not configured"', () => {
  const s = cookieScopeFor({ isProd: true, domain: '' });
  assert.equal(s.domain, undefined);
});

test('clearCookieScopeFor: no domain → just path', () => {
  const c = clearCookieScopeFor({});
  assert.equal(c.path, '/');
  assert.equal(c.domain, undefined);
});

test('clearCookieScopeFor: with domain → path + domain', () => {
  const c = clearCookieScopeFor({ domain: '.memesh.co.il' });
  assert.equal(c.path, '/');
  assert.equal(c.domain, '.memesh.co.il');
});
