import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpolate, placeholdersIn } from './interpolate';

test('interpolate substitutes declared tokens', () => {
  assert.equal(interpolate('עד {{hours}} שעות', { hours: 24 }), 'עד 24 שעות');
  assert.equal(interpolate('{{a}}-{{b}}', { a: 'x', b: 'y' }), 'x-y');
});

test('interpolate leaves a missing token literal rather than blanking', () => {
  assert.equal(interpolate('עד {{hours}} שעות', {}), 'עד {{hours}} שעות');
  assert.equal(interpolate('no tokens', { hours: 1 }), 'no tokens');
});

test('interpolate handles zero and repeated tokens', () => {
  assert.equal(interpolate('{{n}} + {{n}}', { n: 0 }), '0 + 0');
});

test('placeholdersIn returns the distinct token names', () => {
  assert.deepEqual(placeholdersIn('עד {{hours}} שעות, עוד {{hours}}').sort(), ['hours']);
  assert.deepEqual(placeholdersIn('none here'), []);
});
