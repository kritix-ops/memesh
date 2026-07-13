// Replace {{name}} tokens in a content template with caller-supplied values.
// Uses the same {{double-brace}} convention as the existing editable email copy
// (card_settings). An unknown/missing token is left literal rather than throwing
// or blanking — the registry integrity test guarantees a default only references
// declared placeholders, so a leftover token means a caller forgot a var, which
// is visible (and thus fixable) instead of silently empty.

export function interpolate(
  template: string,
  vars: Record<string, string | number> = {},
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** The placeholder names a template actually references, e.g. "עד {{hours}}" → ["hours"]. */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) found.add(m[1]!);
  return [...found];
}
