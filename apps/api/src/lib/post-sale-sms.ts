/**
 * Pure helpers for the post-sale SMS that goes out after a card is created —
 * either by a cashier via POST /cards (POS) or by the WooCommerce webhook
 * after an online checkout completes (WC). Kept separate from the route
 * files so the Hebrew copy + URL shape are unit-testable without standing
 * up the SMS provider, DB, env validation, or Fastify.
 *
 * See _plans/2026-06-22-pos-sell-sms-magic-link.md and
 *     _plans/2026-06-22-wc-post-purchase-sms.md
 * for the design rationale.
 */

export interface PostSaleSmsCard {
  totalEntries: number;
  expiresAt: Date | null;
}

/**
 * Build the post-sale SMS body. The `link` argument is expected to be
 * `${CUSTOMER_BASE_URL}/checkout-complete?token=<raw>` — built by the caller
 * so this function does not need access to env.
 *
 * Body shape branches on card count:
 *   - 1 card: includes the per-card teaser (entry count + expiry) so the
 *     buyer gets an at-a-glance confirmation matching the POS receipt.
 *   - 2+ cards: generic "N כרטיסיות חדשות" copy that steers the buyer to
 *     the personal area where they see all cards. We deliberately do NOT
 *     show one card's count/expiry in a multi-card SMS — that would be a
 *     false at-a-glance claim about cards the customer can't see in the
 *     body. See decision in _plans/2026-06-22-wc-post-purchase-sms.md.
 */
export const buildPostSaleSmsBody = (opts: {
  cards: ReadonlyArray<PostSaleSmsCard>;
  link: string;
}): string => {
  if (opts.cards.length === 0) {
    // Defensive: the caller should not invoke this with zero cards (the
    // webhook path bails out before reaching here when no cards were
    // minted). If it ever happens, fall back to a safe link-only body
    // rather than throwing — the customer still gets a working magic link.
    return `הכרטיסייה שלך ב-Memesh מוכנה! צפייה באזור האישי: ${opts.link}`;
  }
  if (opts.cards.length === 1) {
    const c = opts.cards[0]!;
    const expiryClause = c.expiresAt
      ? `, תוקף עד ${c.expiresAt.toISOString().slice(0, 10)}`
      : ' (ללא תפוגה)';
    return `הכרטיסייה שלך ב-Memesh נוצרה! ${c.totalEntries} כניסות${expiryClause}. צפייה בכרטיסייה: ${opts.link}`;
  }
  return `נוצרו ${opts.cards.length} כרטיסיות חדשות ב-Memesh! לצפייה באזור האישי: ${opts.link}`;
};
