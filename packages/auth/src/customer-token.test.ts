import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthConfig } from './jwt';
import { signAccessToken } from './jwt';
import { signCustomerToken, verifyCustomerToken } from './customer-token';

const customerConfig: AuthConfig = {
  secret: 'customer-secret-that-is-at-least-32-characters',
  issuer: 'memesh',
  audience: 'memesh-customer',
};

const staffConfig: AuthConfig = {
  secret: 'customer-secret-that-is-at-least-32-characters',
  issuer: 'memesh',
  audience: 'memesh-api',
};

const customerId = '550e8400-e29b-41d4-a716-446655440000';

test('signCustomerToken + verifyCustomerToken roundtrip', async () => {
  const token = await signCustomerToken(customerId, customerConfig);
  const result = await verifyCustomerToken(token, customerConfig);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.sub, customerId);
    assert.equal(result.claims.aud, 'memesh-customer');
  }
});

test('a staff-audience token is rejected by the customer verifier', async () => {
  const staffToken = await signAccessToken({ sub: customerId, role: 'cashier' }, staffConfig);
  const result = await verifyCustomerToken(staffToken, customerConfig);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_claims');
});

test('a customer token is rejected on a different (staff) audience', async () => {
  const token = await signCustomerToken(customerId, customerConfig);
  const result = await verifyCustomerToken(token, staffConfig);
  assert.equal(result.ok, false);
});

test('verifyCustomerToken rejects garbage', async () => {
  const result = await verifyCustomerToken('not-a-jwt', customerConfig);
  assert.equal(result.ok, false);
});
