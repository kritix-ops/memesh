import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signBookingToken, verifyBookingToken } from './booking-token.js';
import type { KeyResolver } from './token.js';

const SECRET = 'a-booking-secret-at-least-32-chars!!';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (keyId) => (keyId === '1' ? SECRET : undefined),
};

test('signBookingToken + verifyBookingToken roundtrip', () => {
  const token = signBookingToken({ bookingId: 'bk-1', version: 1 }, resolver);
  const res = verifyBookingToken(token, resolver);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.payload.bookingId, 'bk-1');
  assert.equal(res.payload.version, 1);
});

test('a different version produces a different token (swap re-mint)', () => {
  const v1 = signBookingToken({ bookingId: 'bk-1', version: 1 }, resolver);
  const v2 = signBookingToken({ bookingId: 'bk-1', version: 2 }, resolver);
  assert.notEqual(v1, v2);
  // v1 still verifies structurally; its payload.version is 1, which the scanner
  // compares against the booking's current barcode_version to reject a stale QR.
  const res = verifyBookingToken(v1, resolver);
  assert.equal(res.ok && res.payload.version, 1);
});

test('a tampered token is rejected', () => {
  const token = signBookingToken({ bookingId: 'bk-1', version: 1 }, resolver);
  const last = token.slice(-1);
  const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  assert.equal(verifyBookingToken(tampered, resolver).ok, false);
});

test('an unknown key id is rejected', () => {
  const token = signBookingToken({ bookingId: 'bk-1', version: 1 }, resolver);
  const other: KeyResolver = {
    resolveSigningKey: () => ({ keyId: '9', secret: 'x' }),
    resolveVerifyKey: () => undefined,
  };
  const res = verifyBookingToken(token, other);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'unknown_key_id');
});

test('a card token (v1 prefix) is not accepted as a booking token', () => {
  const res = verifyBookingToken('v1.abc.def', resolver);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'unknown_version');
});
