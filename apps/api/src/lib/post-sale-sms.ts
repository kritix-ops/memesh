/**
 * Pure helpers for the post-sale SMS that goes out when a cashier creates a
 * card via POST /cards. Kept separate from cards.ts so the Hebrew copy +
 * URL shape are unit-testable without standing up the SMS provider, DB, env
 * validation, or Fastify.
 *
 * See _plans/2026-06-22-pos-sell-sms-magic-link.md for the design rationale.
 */

/**
 * Build the post-sale SMS body for a cashier-created card. The `link`
 * argument is expected to be `${CUSTOMER_BASE_URL}/checkout-complete?
 * token=<raw>` — built by the caller so this function does not need access
 * to env.
 */
export const buildPosSellSmsBody = (opts: {
  totalEntries: number;
  expiresAt: Date | null;
  link: string;
}): string => {
  const expiryClause = opts.expiresAt
    ? `, תוקף עד ${opts.expiresAt.toISOString().slice(0, 10)}`
    : ' (ללא תפוגה)';
  return `הכרטיסייה שלך ב-Memesh נוצרה! ${opts.totalEntries} כניסות${expiryClause}. צפייה בכרטיסייה: ${opts.link}`;
};
