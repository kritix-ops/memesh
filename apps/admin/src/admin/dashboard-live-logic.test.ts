import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeStatusLevel,
  deltaDirection,
  deriveWeekAheadRows,
  formatIls,
  formatSigned,
  formatSignedPct,
  sortRoundsByStart,
} from './dashboard-live-logic';

// --- computeStatusLevel: band boundaries (defaults 70 / 90) -----------------

test('computeStatusLevel: below the warning pct is green', () => {
  assert.equal(computeStatusLevel(0, 70, 90), 'green');
  assert.equal(computeStatusLevel(69.9, 70, 90), 'green');
});

test('computeStatusLevel: at/above warning but below danger is amber', () => {
  assert.equal(computeStatusLevel(70, 70, 90), 'amber');
  assert.equal(computeStatusLevel(89.9, 70, 90), 'amber');
});

test('computeStatusLevel: at/above danger is red, including a full round', () => {
  assert.equal(computeStatusLevel(90, 70, 90), 'red');
  assert.equal(computeStatusLevel(100, 70, 90), 'red');
  assert.equal(computeStatusLevel(140, 70, 90), 'red'); // oversell still red
});

test('computeStatusLevel: honors custom thresholds', () => {
  assert.equal(computeStatusLevel(80, 80, 95), 'amber');
  assert.equal(computeStatusLevel(79, 80, 95), 'green');
  assert.equal(computeStatusLevel(95, 80, 95), 'red');
});

// --- deltaDirection ---------------------------------------------------------

test('deltaDirection: null delta has no direction', () => {
  assert.equal(deltaDirection(null), null);
});

test('deltaDirection: positive up, negative down, zero flat', () => {
  assert.equal(deltaDirection(5), 'up');
  assert.equal(deltaDirection(-3), 'down');
  assert.equal(deltaDirection(0), 'flat');
});

// --- formatSigned / formatSignedPct / formatIls -----------------------------

test('formatSigned: sign prefix only for positives', () => {
  assert.equal(formatSigned(3), '+3');
  assert.equal(formatSigned(-8), '-8');
  assert.equal(formatSigned(0), '0');
});

test('formatSignedPct: rounds and appends percent', () => {
  assert.equal(formatSignedPct(12), '+12%');
  assert.equal(formatSignedPct(12.4), '+12%');
  assert.equal(formatSignedPct(-8), '-8%');
  assert.equal(formatSignedPct(0), '0%');
});

test('formatIls: shekel prefix, grouped western digits, no decimals', () => {
  assert.equal(formatIls(0), '₪0');
  assert.equal(formatIls(3420), '₪3,420');
  assert.equal(formatIls(1234567), '₪1,234,567');
  assert.equal(formatIls(45.83), '₪46'); // rounds
});

// --- sortRoundsByStart ------------------------------------------------------

test('sortRoundsByStart: orders by HH:MM without mutating input', () => {
  const input = [{ startTime: '20:00' }, { startTime: '16:00' }, { startTime: '18:00' }];
  const sorted = sortRoundsByStart(input);
  assert.deepEqual(
    sorted.map((r) => r.startTime),
    ['16:00', '18:00', '20:00'],
  );
  // original untouched
  assert.deepEqual(
    input.map((r) => r.startTime),
    ['20:00', '16:00', '18:00'],
  );
});

// --- deriveWeekAheadRows ----------------------------------------------------

test('deriveWeekAheadRows: distinct rounds across days, ordered by start', () => {
  const days = [
    {
      rounds: [
        { label: 'ערב', startTime: '20:00' },
        { label: 'צהריים', startTime: '16:00' },
      ],
    },
    {
      rounds: [
        { label: 'צהריים', startTime: '16:00' }, // dup — collapses
        { label: 'אחה"צ', startTime: '18:00' },
      ],
    },
  ];
  assert.deepEqual(deriveWeekAheadRows(days), [
    { label: 'צהריים', startTime: '16:00' },
    { label: 'אחה"צ', startTime: '18:00' },
    { label: 'ערב', startTime: '20:00' },
  ]);
});

test('deriveWeekAheadRows: empty grid yields no rows', () => {
  assert.deepEqual(deriveWeekAheadRows([{ rounds: [] }, { rounds: [] }]), []);
});
