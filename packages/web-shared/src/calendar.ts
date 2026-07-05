// Month math for the booking-calendar popups (plan
// 2026-07-05-booking-window-365): the customer dashboard, the staff rounds
// view, and the WP snippet all page the availability-range API one month at a
// time, bounded by [today, maxDate]. Everything here is pure string/number
// work on ISO dates — no Date-now, no timezone reads — so the three surfaces
// can't drift apart on month boundaries.

/** "YYYY-MM-DD" → its "YYYY-MM" month key. */
export const monthOfIso = (iso: string): string => iso.slice(0, 7);

/** "YYYY-MM" → the month's first date, "YYYY-MM-01". */
export const firstOfMonth = (ym: string): string => `${ym}-01`;

/** "YYYY-MM" shifted by `delta` months (delta may be negative). */
export const addMonths = (ym: string, delta: number): string => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
};

/** Days in a "YYYY-MM" month, leap years included. */
export const daysInMonth = (ym: string): number => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  // Day 0 of the next month is this month's last day. Explicit y/m arguments
  // make this deterministic in any runner timezone.
  return new Date(y, m, 0).getDate();
};

const MONTHS_HE = [
  'ינואר',
  'פברואר',
  'מרץ',
  'אפריל',
  'מאי',
  'יוני',
  'יולי',
  'אוגוסט',
  'ספטמבר',
  'אוקטובר',
  'נובמבר',
  'דצמבר',
] as const;

/** "YYYY-MM" → "יולי 2026". */
export const monthLabelHe = (ym: string): string => {
  const m = Number(ym.slice(5, 7));
  return `${MONTHS_HE[m - 1] ?? ''} ${ym.slice(0, 4)}`;
};

export interface MonthGrid {
  /** Blank cells before day 1 so the grid starts on Sunday (א׳). */
  leadingBlanks: number;
  /** Every date of the month as "YYYY-MM-DD", in order. */
  dates: string[];
}

/** Grid cells for a "YYYY-MM" month in a Sunday-first week. */
export const monthGrid = (ym: string): MonthGrid => {
  const count = daysInMonth(ym);
  // Midday anchor sidesteps DST edges when reading the weekday.
  const leadingBlanks = new Date(`${firstOfMonth(ym)}T12:00:00`).getDay();
  const dates = Array.from({ length: count }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
  return { leadingBlanks, dates };
};
