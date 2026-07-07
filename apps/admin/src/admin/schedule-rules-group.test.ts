import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleRule } from '../lib/api/rounds';
import { groupScheduleRules, isDayMark, monthLabel } from './schedule-rules-group';

// A ScheduleRule with sane defaults; override per case.
function rule(over: Partial<ScheduleRule>): ScheduleRule {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    dateFrom: null,
    dateTo: null,
    weekdayMask: null,
    windows: [],
    outside: 'closed',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// --- isDayMark --------------------------------------------------------------

test('isDayMark: a single closed date with no windows is a day mark', () => {
  assert.equal(isDayMark(rule({ dateFrom: '2026-04-02', dateTo: '2026-04-02' })), true);
  // The sync also writes dateTo=null single dates.
  assert.equal(isDayMark(rule({ dateFrom: '2026-04-14', dateTo: null })), true);
});

test('isDayMark: a free-play whole-day mark still counts (no windows)', () => {
  assert.equal(
    isDayMark(rule({ dateFrom: '2026-04-14', dateTo: '2026-04-14', outside: 'free_play' })),
    true,
  );
});

test('isDayMark: a windowed single date is an activity rule, not a mark', () => {
  assert.equal(
    isDayMark(rule({ dateFrom: '2026-04-02', dateTo: '2026-04-02', windows: [{ start: '16:00', end: '18:00' }] })),
    false,
  );
});

test('isDayMark: date ranges and recurring weekday rules are not marks', () => {
  assert.equal(isDayMark(rule({ dateFrom: '2026-04-01', dateTo: '2026-04-30' })), false);
  assert.equal(isDayMark(rule({ weekdayMask: 64 })), false); // every Saturday
});

// --- groupScheduleRules -----------------------------------------------------

test('groupScheduleRules: splits active rules from day marks', () => {
  const rules = [
    rule({ id: 'win', dateFrom: '2026-04-02', dateTo: '2026-04-02', windows: [{ start: '16:00', end: '18:00' }] }),
    rule({ id: 'sat1', dateFrom: '2026-01-02', dateTo: '2026-01-02' }),
    rule({ id: 'sat2', dateFrom: '2026-01-09', dateTo: '2026-01-09' }),
    rule({ id: 'weekly', weekdayMask: 64 }),
  ];
  const g = groupScheduleRules(rules);
  assert.deepEqual(
    g.activeRules.map((r) => r.id).sort(),
    ['weekly', 'win'],
  );
  assert.equal(g.dayMarkCount, 2);
});

test('groupScheduleRules: buckets day marks by month, chronologically', () => {
  const rules = [
    rule({ id: 'apr', dateFrom: '2026-04-22', dateTo: '2026-04-22' }),
    rule({ id: 'jan2', dateFrom: '2026-01-09', dateTo: '2026-01-09' }),
    rule({ id: 'jan1', dateFrom: '2026-01-02', dateTo: '2026-01-02' }),
  ];
  const g = groupScheduleRules(rules);
  assert.deepEqual(g.dayMarkMonths.map((m) => m.key), ['2026-01', '2026-04']);
  // Within a month, sorted by date.
  assert.deepEqual(g.dayMarkMonths[0]?.rules.map((r) => r.id), ['jan1', 'jan2']);
  assert.equal(g.dayMarkMonths[0]?.label, 'ינואר 2026');
});

test('groupScheduleRules: empty input yields empty groups', () => {
  const g = groupScheduleRules([]);
  assert.deepEqual(g.activeRules, []);
  assert.deepEqual(g.dayMarkMonths, []);
  assert.equal(g.dayMarkCount, 0);
});

// --- monthLabel -------------------------------------------------------------

test('monthLabel: Hebrew month name + year', () => {
  assert.equal(monthLabel('2026-09'), 'ספטמבר 2026');
  assert.equal(monthLabel('2026-01'), 'ינואר 2026');
});
