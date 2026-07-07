import type { ScheduleRule } from '../lib/api/rounds';

// ---------------------------------------------------------------------------
// Grouping for the "מתי הסבבים פועלים" list. The holiday sync writes one
// single-date rule per Shabbat and per holiday, so a year of closures floods
// the flat list (Yanay 2026-07-07: endless scroll → accordion). We split the
// rules into two buckets:
//   - activeRules: admin-authored rules that shape a day's rounds (time
//     windows, date ranges, recurring weekdays). Few, and the ones the admin
//     actively manages — always shown.
//   - dayMark months: single-date, whole-day marks (closed or free-play, no
//     windows). The bulk. Grouped by calendar month and collapsed by default.
// Pure so it unit-tests without a component.
// ---------------------------------------------------------------------------

const HE_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

/** Hebrew "אפריל 2026" from a "YYYY-MM" key. */
export function monthLabel(ym: string): string {
  const idx = Number(ym.slice(5, 7)) - 1;
  const name = HE_MONTHS[idx] ?? ym.slice(5, 7);
  return `${name} ${ym.slice(0, 4)}`;
}

/**
 * A "day mark" is a single specific date with no time windows — the whole day
 * is either closed or free-play. That's exactly what the holiday/Shabbat sync
 * emits, and what clutters the list. A rule with windows, a real date range, or
 * a recurring weekday mask is an activity rule the admin authored, not a mark.
 */
export function isDayMark(r: ScheduleRule): boolean {
  const singleDate =
    r.dateFrom !== null &&
    (r.dateTo === r.dateFrom || (r.dateTo === null && r.weekdayMask === null));
  return singleDate && r.windows.length === 0;
}

export interface ClosureMonth {
  /** "YYYY-MM" */
  key: string;
  /** "אפריל 2026" */
  label: string;
  rules: ScheduleRule[];
}

export interface GroupedScheduleRules {
  /** Windowed / range / recurring rules — always visible. */
  activeRules: ScheduleRule[];
  /** Single-date whole-day marks, sorted by date and bucketed by month. */
  dayMarkMonths: ClosureMonth[];
  /** Total day-mark count across all months (for the section header). */
  dayMarkCount: number;
}

export function groupScheduleRules(rules: ScheduleRule[]): GroupedScheduleRules {
  const activeRules: ScheduleRule[] = [];
  const marks: ScheduleRule[] = [];
  for (const r of rules) {
    if (isDayMark(r)) marks.push(r);
    else activeRules.push(r);
  }
  // Chronological — dateFrom is always set on a day mark (isDayMark requires it).
  marks.sort((a, b) => (a.dateFrom ?? '').localeCompare(b.dateFrom ?? ''));

  const byMonth = new Map<string, ScheduleRule[]>();
  for (const r of marks) {
    const key = (r.dateFrom ?? '').slice(0, 7);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(r);
    else byMonth.set(key, [r]);
  }
  const dayMarkMonths: ClosureMonth[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, monthRules]) => ({ key, label: monthLabel(key), rules: monthRules }));

  return { activeRules, dayMarkMonths, dayMarkCount: marks.length };
}
