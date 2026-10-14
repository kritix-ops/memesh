import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCardCurrentlyActive, isCardDateExpired } from './card-status';

const NOW = new Date('2026-07-02T12:00:00.000Z');

// --- isCardDateExpired --------------------------------------------------------

test('isCardDateExpired is false for a forever card (no expiry date)', () => {
  assert.equal(isCardDateExpired(null, NOW), false);
});

test('isCardDateExpired is true for a past expiry date', () => {
  assert.equal(isCardDateExpired('2026-07-01T12:00:00.000Z', NOW), true);
});

test('isCardDateExpired treats expiresAt == now as expired (punch-flow boundary)', () => {
  assert.equal(isCardDateExpired(NOW.toISOString(), NOW), true);
});

test('isCardDateExpired is false for a future expiry date', () => {
  assert.equal(isCardDateExpired('2026-07-02T12:00:00.001Z', NOW), false);
});

// --- isCardCurrentlyActive ----------------------------------------------------

test('isCardCurrentlyActive: a date-expired card is inactive even with isActive=true', () => {
  // Regression: badges read isActive alone, and nothing flips it on date-expiry.
  assert.equal(isCardCurrentlyActive({ isActive: true, expiresAt: '2026-06-01T00:00:00.000Z' }, NOW), false);
});

test('isCardCurrentlyActive: a live card with a future expiry is active', () => {
  assert.equal(isCardCurrentlyActive({ isActive: true, expiresAt: '2027-06-01T00:00:00.000Z' }, NOW), true);
});

test('isCardCurrentlyActive: a forever card follows the isActive flag', () => {
  assert.equal(isCardCurrentlyActive({ isActive: true, expiresAt: null }, NOW), true);
  assert.equal(isCardCurrentlyActive({ isActive: false, expiresAt: null }, NOW), false);
});

test('isCardCurrentlyActive: an exhausted card (isActive=false) is inactive before its expiry', () => {
  assert.equal(isCardCurrentlyActive({ isActive: false, expiresAt: '2027-06-01T00:00:00.000Z' }, NOW), false);
});
