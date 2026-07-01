import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIntFilter } from './report-filter-logic';

// --- parseIntFilter: empty input means "no filter" ---------------------------

test('parseIntFilter: empty string is no filter, not 0', () => {
  // Regression: Number('') is 0, which used to leak usageMaxPct=0 into the
  // cards report query and hide every card with at least one punch.
  assert.equal(parseIntFilter('', 0, 100), undefined);
});

test('parseIntFilter: whitespace-only string is no filter', () => {
  assert.equal(parseIntFilter('   ', 0, 100), undefined);
});

// --- parseIntFilter: valid values --------------------------------------------

test('parseIntFilter: explicit 0 is a real value when min allows it', () => {
  assert.equal(parseIntFilter('0', 0, 100), 0);
});

test('parseIntFilter: bounds are inclusive', () => {
  assert.equal(parseIntFilter('100', 0, 100), 100);
  assert.equal(parseIntFilter('1', 1, 3650), 1);
  assert.equal(parseIntFilter('3650', 1, 3650), 3650);
});

test('parseIntFilter: trims surrounding whitespace', () => {
  assert.equal(parseIntFilter(' 30 ', 0, 100), 30);
});

// --- parseIntFilter: rejected values -----------------------------------------

test('parseIntFilter: out-of-range values are no filter', () => {
  assert.equal(parseIntFilter('101', 0, 100), undefined);
  assert.equal(parseIntFilter('-1', 0, 100), undefined);
  assert.equal(parseIntFilter('0', 1, 3650), undefined);
  assert.equal(parseIntFilter('5000', 1, 3650), undefined);
});

test('parseIntFilter: non-integers are no filter', () => {
  assert.equal(parseIntFilter('2.5', 0, 100), undefined);
  assert.equal(parseIntFilter('abc', 0, 100), undefined);
  assert.equal(parseIntFilter('1e2', 0, 100), 100); // scientific notation still an integer
  assert.equal(parseIntFilter('NaN', 0, 100), undefined);
  assert.equal(parseIntFilter('Infinity', 0, 100), undefined);
});
