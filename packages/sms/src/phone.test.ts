import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeIsraeliPhone } from './phone';

test('normalizeIsraeliPhone strips dashes and spaces from a local-form number', () => {
  assert.equal(normalizeIsraeliPhone('052-345-6789'), '0523456789');
  assert.equal(normalizeIsraeliPhone('052 345 6789'), '0523456789');
  assert.equal(normalizeIsraeliPhone(' 052-3456789 '), '0523456789');
});

test('normalizeIsraeliPhone drops +972 country code and adds a leading 0', () => {
  assert.equal(normalizeIsraeliPhone('+972-52-345-6789'), '0523456789');
  assert.equal(normalizeIsraeliPhone('+972 52 345 6789'), '0523456789');
  assert.equal(normalizeIsraeliPhone('+972523456789'), '0523456789');
});

test('normalizeIsraeliPhone drops 972 prefix without a leading + as well', () => {
  assert.equal(normalizeIsraeliPhone('972523456789'), '0523456789');
});

test('normalizeIsraeliPhone passes through an already-normalized number', () => {
  assert.equal(normalizeIsraeliPhone('0523456789'), '0523456789');
});

test('normalizeIsraeliPhone keeps a foreign +<country><digits> intact (no Israeli rewrite)', () => {
  // We do not invent country logic for non-IL — providers like 019 will reject;
  // that's the correct surface (rather than silently corrupting the number).
  assert.equal(normalizeIsraeliPhone('+1 415 555 0100'), '+14155550100');
});

test('normalizeIsraeliPhone throws on empty or null', () => {
  assert.throws(() => normalizeIsraeliPhone(''), /phone is required/);
  assert.throws(() => normalizeIsraeliPhone('   '), /phone is required/);
  assert.throws(() => normalizeIsraeliPhone(null), /phone is required/);
  assert.throws(() => normalizeIsraeliPhone(undefined), /phone is required/);
});

test('normalizeIsraeliPhone throws on input with no digits', () => {
  assert.throws(() => normalizeIsraeliPhone('not-a-phone'), /phone has no digits/);
});
