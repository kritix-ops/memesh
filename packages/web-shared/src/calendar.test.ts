import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMonths,
  daysInMonth,
  firstOfMonth,
  monthGrid,
  monthLabelHe,
  monthOfIso,
} from './calendar';

test('monthOfIso and firstOfMonth round-trip', () => {
  assert.equal(monthOfIso('2026-07-05'), '2026-07');
  assert.equal(firstOfMonth('2026-07'), '2026-07-01');
});

test('addMonths walks forward across year ends', () => {
  assert.equal(addMonths('2026-07', 1), '2026-08');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-07', 12), '2027-07');
  assert.equal(addMonths('2026-07', 6), '2027-01');
});

test('addMonths walks backward across year ends', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-07', -7), '2025-12');
  assert.equal(addMonths('2026-07', 0), '2026-07');
});

test('daysInMonth handles month lengths and leap years', () => {
  assert.equal(daysInMonth('2026-07'), 31);
  assert.equal(daysInMonth('2026-06'), 30);
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29, '2028 is a leap year');
});

test('monthLabelHe names the month in Hebrew', () => {
  assert.equal(monthLabelHe('2026-07'), 'יולי 2026');
  assert.equal(monthLabelHe('2027-01'), 'ינואר 2027');
});

test('monthGrid starts the week on Sunday with the right offset', () => {
  // 2026-07-01 is a Wednesday → three blanks (א׳ ב׳ ג׳) before day 1.
  const july = monthGrid('2026-07');
  assert.equal(july.leadingBlanks, 3);
  assert.equal(july.dates.length, 31);
  assert.equal(july.dates[0], '2026-07-01');
  assert.equal(july.dates[30], '2026-07-31');

  // 2026-11-01 is a Sunday → no blanks.
  const nov = monthGrid('2026-11');
  assert.equal(nov.leadingBlanks, 0);
  assert.equal(nov.dates.length, 30);
});
