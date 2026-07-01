// Pure presentation logic for the live rounds dashboard. No React, no I/O —
// everything here is a deterministic function so it can be unit-tested with the
// repo's node:test runner (there is no jsdom/RTL setup, so rendering behavior is
// covered by manual QA + the endpoint integration test instead).

export type StatusLevel = 'green' | 'amber' | 'red';
export type DeltaDirection = 'up' | 'down' | 'flat';

/**
 * Classify a round's fill into a status color band. Thresholds come from
 * dashboard_settings (defaults 70/90). Boundaries follow the plan's visual
 * table: green below the warning pct, amber in [warn, danger), red at or above
 * the danger pct. A full round (pctFull ≥ 100) lands in red via the same rule.
 * The DB guarantees warnPct < dangerPct, so the bands never invert.
 */
export function computeStatusLevel(pctFull: number, warnPct: number, dangerPct: number): StatusLevel {
  if (pctFull >= dangerPct) return 'red';
  if (pctFull >= warnPct) return 'amber';
  return 'green';
}

/** Direction of a day-over-day delta. null delta (no comparison point) → null. */
export function deltaDirection(delta: number | null): DeltaDirection | null {
  if (delta === null) return null;
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'flat';
}

/** Signed integer for display: 3 → "+3", -8 → "-8", 0 → "0". */
export function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Signed, rounded percentage for display: 12.4 → "+12%", -8 → "-8%". */
export function formatSignedPct(n: number): string {
  return `${formatSigned(Math.round(n))}%`;
}

/** ILS with a ₪ prefix, western digits, thousands grouping, no decimals: 3420 → "₪3,420". */
export function formatIls(amount: number): string {
  return `₪${Math.round(amount).toLocaleString('en-US')}`;
}

/** Sort rounds chronologically by "HH:MM" start time. Returns a new array. */
export function sortRoundsByStart<T extends { startTime: string }>(rounds: readonly T[]): T[] {
  return [...rounds].sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export interface WeekAheadRow {
  label: string;
  startTime: string;
}

/**
 * Collapse the 7-day matrix into its distinct round rows, ordered by start time.
 * The endpoint already returns every active round on every day, but deriving the
 * row set from the union keeps the grid correct even if a day's set ever differs.
 */
export function deriveWeekAheadRows(
  days: ReadonlyArray<{ rounds: ReadonlyArray<{ label: string; startTime: string }> }>,
): WeekAheadRow[] {
  const seen = new Map<string, WeekAheadRow>();
  for (const day of days) {
    for (const r of day.rounds) {
      const key = `${r.startTime}|${r.label}`;
      if (!seen.has(key)) seen.set(key, { label: r.label, startTime: r.startTime });
    }
  }
  return [...seen.values()].sort((a, b) => a.startTime.localeCompare(b.startTime));
}
