import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtDate, labelHasTime, roundTitle } from './formatting';

test('fmtDate renders ISO dates as dd.mm.yyyy', () => {
  assert.equal(fmtDate('2026-07-05'), '05.07.2026');
});

test('labelHasTime spots embedded hours in any common admin spelling', () => {
  assert.equal(labelHasTime('בוקר 9:00 - 14:00'), true);
  assert.equal(labelHasTime('בוקר 09:00'), true);
  assert.equal(labelHasTime('בוקר'), false);
  assert.equal(labelHasTime('סבב 3'), false);
});

test('roundTitle appends hours only when the label lacks them', () => {
  assert.equal(roundTitle('בוקר', '09:00', '14:00'), 'בוקר 09:00–14:00');
  assert.equal(roundTitle('בוקר 9:00 - 14:00', '09:00', '14:00'), 'בוקר 9:00 - 14:00');
});
