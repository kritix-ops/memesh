// Parsers for the free-text numeric filter boxes in the reports UI.
//
// Number('') is 0, so an untouched box must map to undefined (no filter),
// never 0 — otherwise an empty "usage max %" box silently becomes
// usageMaxPct=0 and the cards report hides every card with any usage.

/** Integer percent 0..100, or undefined when the box is empty or invalid. */
export const parsePctInput = (raw: string): number | undefined => {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
};

/** Positive integer day count, or undefined when the box is empty or invalid. */
export const parseDaysInput = (raw: string): number | undefined => {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
