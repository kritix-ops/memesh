import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDaysInput, parsePctInput } from './filter-inputs';

// --- parsePctInput -----------------------------------------------------------

test('parsePctInput: empty box means no filter, not 0', () => {
  // Regression: Number('') is 0, which used to send usageMaxPct=0 and hide
  // every card with any usage from the cards report.
  assert.equal(parsePctInput(''), undefined);
  assert.equal(parsePctInput('   '), undefined);
});

test('parsePctInput: accepts integers 0..100 inclusive', () => {
  assert.equal(parsePctInput('0'), 0);
  assert.equal(parsePctInput('50'), 50);
  assert.equal(parsePctInput('100'), 100);
  assert.equal(parsePctInput(' 25 '), 25);
});

test('parsePctInput: rejects out-of-range and non-integer values', () => {
  assert.equal(parsePctInput('-1'), undefined);
  assert.equal(parsePctInput('101'), undefined);
  assert.equal(parsePctInput('12.5'), undefined);
  assert.equal(parsePctInput('abc'), undefined);
});

// --- parseDaysInput ----------------------------------------------------------

test('parseDaysInput: empty box means no filter', () => {
  assert.equal(parseDaysInput(''), undefined);
  assert.equal(parseDaysInput('   '), undefined);
});

test('parseDaysInput: accepts positive integers only', () => {
  assert.equal(parseDaysInput('1'), 1);
  assert.equal(parseDaysInput('30'), 30);
  assert.equal(parseDaysInput(' 365 '), 365);
});

test('parseDaysInput: rejects zero, negatives, and non-integers', () => {
  assert.equal(parseDaysInput('0'), undefined);
  assert.equal(parseDaysInput('-7'), undefined);
  assert.equal(parseDaysInput('2.5'), undefined);
  assert.equal(parseDaysInput('abc'), undefined);
});
