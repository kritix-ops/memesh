import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signToken, verifyToken } from './token.js';
import type { KeyResolver } from './token.js';

const makeResolver = (keys: Record<string, string>, currentKeyId: string): KeyResolver => ({
  resolveSigningKey: () => ({ keyId: currentKeyId, secret: keys[currentKeyId]! }),
  resolveVerifyKey: (keyId) => keys[keyId],
});

const fixture = {
  punchCardId: '550e8400-e29b-41d4-a716-446655440000',
  customerId: '550e8400-e29b-41d4-a716-446655440001',
  createdTs: 1746000000,
  serial: 'M-20260517-0042',
};

test('signToken + verifyToken roundtrips and returns the same payload', () => {
  const resolver = makeResolver({ '1': 'secret-one' }, '1');
  const token = signToken(fixture, resolver);
  const result = verifyToken(token, resolver);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.punchCardId, fixture.punchCardId);
    assert.equal(result.payload.customerId, fixture.customerId);
    assert.equal(result.payload.createdTs, fixture.createdTs);
    assert.equal(result.payload.serial, fixture.serial);
    assert.equal(result.payload.keyId, '1');
  }
});

test('verifyToken rejects a tampered payload with bad_signature', () => {
  const resolver = makeResolver({ '1': 'secret-one' }, '1');
  const token = signToken(fixture, resolver);
  const parts = token.split('.');
  const tamperedPayload = Buffer.from('a|b|123|M-20260517-9999|1', 'utf8').toString('base64url');
  const tamperedToken = [parts[0], tamperedPayload, parts[2]].join('.');
  const result = verifyToken(tamperedToken, resolver);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'bad_signature');
});

test('verifyToken rejects a wrong secret with bad_signature', () => {
  const signResolver = makeResolver({ '1': 'secret-one' }, '1');
  const verifyResolver = makeResolver({ '1': 'wrong-secret' }, '1');
  const token = signToken(fixture, signResolver);
  const result = verifyToken(token, verifyResolver);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'bad_signature');
});

test('verifyToken rejects unknown key id', () => {
  const signResolver = makeResolver({ '1': 'secret-one' }, '1');
  const verifyResolver = makeResolver({ '2': 'secret-two' }, '2');
  const token = signToken(fixture, signResolver);
  const result = verifyToken(token, verifyResolver);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'unknown_key_id');
});

test('verifyToken rejects a structurally invalid token', () => {
  const resolver = makeResolver({ '1': 'secret-one' }, '1');
  const result = verifyToken('not-a-token', resolver);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_format');
});

test('verifyToken rejects unknown version prefix', () => {
  const resolver = makeResolver({ '1': 'secret-one' }, '1');
  const token = signToken(fixture, resolver);
  const parts = token.split('.');
  const wrongVersion = ['v9', parts[1], parts[2]].join('.');
  const result = verifyToken(wrongVersion, resolver);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'unknown_version');
});

test('key rotation: new tokens use new key, old tokens still verify', () => {
  const rotating = makeResolver({ '1': 'old-secret', '2': 'new-secret' }, '2');
  const oldSigner = makeResolver({ '1': 'old-secret' }, '1');

  const newToken = signToken(fixture, rotating);
  const newResult = verifyToken(newToken, rotating);
  assert.equal(newResult.ok, true);
  if (newResult.ok) assert.equal(newResult.payload.keyId, '2');

  const oldToken = signToken(fixture, oldSigner);
  const oldResult = verifyToken(oldToken, rotating);
  assert.equal(oldResult.ok, true);
  if (oldResult.ok) assert.equal(oldResult.payload.keyId, '1');
});
