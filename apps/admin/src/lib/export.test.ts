import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromDateInput, fromDateInputEnd, presetRange } from './export';

// --- fromDateInput / fromDateInputEnd ----------------------------------------

test('fromDateInput parses to the start of the local day', () => {
  const d = fromDateInput('2026-06-30');
  assert.ok(d);
  assert.deepEqual(
    [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()],
    [2026, 5, 30, 0, 0],
  );
});

test('fromDateInputEnd parses to the end of the local day', () => {
  // Regression: range "to" inputs used the start-of-day parse, which silently
  // excluded everything that happened during the selected last day.
  const d = fromDateInputEnd('2026-06-30');
  assert.ok(d);
  assert.deepEqual(
    [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()],
    [2026, 5, 30, 23, 59, 59],
  );
});

test('fromDateInputEnd returns null for empty or malformed input', () => {
  assert.equal(fromDateInputEnd(''), null);
  assert.equal(fromDateInputEnd('30/06/2026'), null);
});

test('a custom range built from the two parsers covers the whole end day', () => {
  const from = fromDateInput('2026-06-01');
  const to = fromDateInputEnd('2026-06-30');
  const eveningOfLastDay = new Date(2026, 5, 30, 18, 30);
  assert.ok(from && to);
  assert.ok(from <= eveningOfLastDay && eveningOfLastDay <= to);
});

// --- presetRange sanity -------------------------------------------------------

test('presetRange today spans the full local day', () => {
  const now = new Date(2026, 6, 2, 14, 0);
  const r = presetRange('today', now);
  assert.ok(r.from && r.to);
  assert.deepEqual([r.from.getHours(), r.from.getMinutes()], [0, 0]);
  assert.deepEqual([r.to.getHours(), r.to.getMinutes()], [23, 59]);
});

test('presetRange allTime is unbounded', () => {
  const r = presetRange('allTime');
  assert.equal(r.from, null);
  assert.equal(r.to, null);
});
