import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { AuthConfig } from './jwt';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from './jwt';

const baseConfig: AuthConfig = {
  secret: 'test-secret-that-is-at-least-32-characters-long',
  issuer: 'memesh',
  audience: 'memesh-api',
};

const userId = '550e8400-e29b-41d4-a716-446655440000';

test('signAccessToken + verifyAccessToken roundtrip', async () => {
  const token = await signAccessToken({ sub: userId, role: 'manager' }, baseConfig);
  const result = await verifyAccessToken(token, baseConfig);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.sub, userId);
    assert.equal(result.claims.role, 'manager');
    assert.equal(result.claims.iss, 'memesh');
    assert.equal(result.claims.aud, 'memesh-api');
  }
});

test('verifyAccessToken rejects wrong secret', async () => {
  const token = await signAccessToken({ sub: userId, role: 'cashier' }, baseConfig);
  const result = await verifyAccessToken(token, {
    ...baseConfig,
    secret: 'a-different-secret-that-is-also-32-characters-long',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_signature');
});

test('verifyAccessToken rejects wrong audience', async () => {
  const token = await signAccessToken({ sub: userId, role: 'cashier' }, baseConfig);
  const result = await verifyAccessToken(token, {
    ...baseConfig,
    audience: 'wrong-audience',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_claims');
});

test('verifyAccessToken rejects expired token', async () => {
  const token = await signAccessToken(
    { sub: userId, role: 'cashier' },
    { ...baseConfig, accessTtl: '1s' },
  );
  await sleep(1100);
  const result = await verifyAccessToken(token, baseConfig);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'expired');
});

test('verifyAccessToken rejects a tampered token', async () => {
  const token = await signAccessToken({ sub: userId, role: 'cashier' }, baseConfig);
  const parts = token.split('.');
  const tampered = [parts[0], parts[1], 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'].join('.');
  const result = await verifyAccessToken(tampered, baseConfig);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_signature');
});

test('signRefreshToken + verifyRefreshToken roundtrip', async () => {
  const token = await signRefreshToken({ sub: userId, role: 'manager' }, baseConfig);
  const result = await verifyRefreshToken(token, baseConfig);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.sub, userId);
    assert.equal(result.claims.role, 'manager');
    assert.equal(result.claims.typ, 'refresh');
  }
});

test('verifyAccessToken rejects a refresh token (wrong_token_type)', async () => {
  const refreshToken = await signRefreshToken({ sub: userId, role: 'admin' }, baseConfig);
  const result = await verifyAccessToken(refreshToken, baseConfig);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'wrong_token_type');
});

test('verifyRefreshToken rejects an access token (wrong_token_type)', async () => {
  const accessToken = await signAccessToken({ sub: userId, role: 'admin' }, baseConfig);
  const result = await verifyRefreshToken(accessToken, baseConfig);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'wrong_token_type');
});

test('verifyAccessToken rejects garbage input', async () => {
  const result = await verifyAccessToken('not-a-jwt', baseConfig);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_format');
});
