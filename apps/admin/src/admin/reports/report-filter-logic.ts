// Pure parsing helpers for the report filter bars, extracted so the rules
// are unit-testable (see report-filter-logic.test.ts).

/**
 * Parse a free-text numeric filter input into an integer, or undefined when
 * the field should not be applied at all. An empty (or whitespace-only)
 * string means "no filter", never 0. Values outside [min, max] and
 * non-integers are also treated as "no filter" rather than clamped, so a
 * half-typed value never silently narrows the report.
 */
export const parseIntFilter = (raw: string, min: number, max: number): number | undefined => {
  const s = raw.trim();
  if (s === '') return undefined;
  const n = Number(s);
  if (!Number.isInteger(n)) return undefined;
  if (n < min || n > max) return undefined;
  return n;
};
