// Console diagnostics for the report screens. Every fetch logs its filters and
// result counts under the `[web admin reports]` tag so a "the report shows
// nothing" bug can be traced from the browser console alone.

/**
 * Report filters as safe to log. The free-text search can hold a customer's
 * name or phone number, so only whether it is set reaches the console.
 */
export function loggableFilters(filters: object): Record<string, unknown> {
  const { q, ...rest } = filters as { q?: unknown } & Record<string, unknown>;
  return typeof q === 'string' && q !== '' ? { ...rest, q: '[set]' } : rest;
}
