// Render + validate the editable Hebrew copy for the three gift-card email
// variants. Same pattern as handoff-thankyou — known placeholders only,
// validation refuses unknown ones at admin-save time so a typo never ships.
//
// Gift templates use TWO placeholder names depending on the audience:
//   - {{buyerFirstName}}     — recipient-facing emails ("X שלח לך מתנה")
//   - {{recipientFirstName}} — buyer-facing emails ("X פתח/ה את המתנה")
// The renderer accepts both so a single function handles every variant.

const ALLOWED = new Set(['buyerFirstName', 'recipientFirstName']);
const NAME_FALLBACK = 'לקוח/ה';

export interface GiftTemplateVars {
  buyerFirstName?: string | null | undefined;
  recipientFirstName?: string | null | undefined;
}

/**
 * Substitute {{buyerFirstName}} and/or {{recipientFirstName}} into a
 * template string. Missing/empty names fall back to a neutral Hebrew label
 * so the rendered text always reads cleanly even when a field is blank.
 */
export const renderGiftTemplate = (template: string, vars: GiftTemplateVars): string => {
  const buyer = (vars.buyerFirstName ?? '').trim() || NAME_FALLBACK;
  const recipient = (vars.recipientFirstName ?? '').trim() || NAME_FALLBACK;
  return template
    .replaceAll('{{buyerFirstName}}', buyer)
    .replaceAll('{{recipientFirstName}}', recipient);
};

/**
 * Validate that a gift template uses only known placeholders. Used by the
 * admin Settings save path. A template that references a placeholder the
 * audience doesn't have (e.g. {{recipientFirstName}} in a recipient-facing
 * template — there's no recipient name on those vars) still validates here;
 * the render call will just substitute the fallback. That is the right
 * tradeoff because admin can preview before saving.
 */
export const validateGiftTemplate = (
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
