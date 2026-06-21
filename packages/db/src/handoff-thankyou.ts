// Render + validate the editable thank-you copy shown to a buyer right
// after a successful WooCommerce checkout (my.memesh.co.il/checkout-complete).
// Same template pattern as renderEmailOtpBody — single allowed placeholder
// for now ({{firstName}}); validation refuses unknown placeholders at
// admin-save time so a typo can't silently break the page.

const ALLOWED = new Set(['firstName']);
const FIRST_NAME_FALLBACK = 'לקוח/ה';

export interface HandoffThankyouVars {
  firstName: string | null | undefined;
}

/**
 * Substitute {{firstName}} into a template string. Empty/missing names fall
 * back to a neutral Hebrew "customer" so the rendered text always reads.
 */
export const renderHandoffThankyou = (template: string, vars: HandoffThankyouVars): string => {
  const firstName = (vars.firstName ?? '').trim() || FIRST_NAME_FALLBACK;
  return template.replaceAll('{{firstName}}', firstName);
};

/**
 * Validate that a template uses only known placeholders. Called from the
 * admin Settings save path so the operator sees an immediate error on a
 * typo like `{{name}}` instead of shipping it literally to customers.
 */
export const validateHandoffThankyouTemplate = (
  template: string,
): { ok: true } | { ok: false; unknown: string[] } => {
  const unknown: string[] = [];
  for (const match of template.matchAll(/\{\{(\w+)\}\}/g)) {
    const name = match[1]!;
    if (!ALLOWED.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true };
};
