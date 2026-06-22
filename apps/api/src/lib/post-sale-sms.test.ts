// Unit tests for the post-sale SMS body builder. Pure-function tests, no DB,
// no SMS provider, no Fastify — the point is to pin down the Hebrew copy
// and the URL shape so a future edit can't silently break the link.
//
// Two call sites share this builder:
//   - POS cashier sale (apps/api/src/routes/cards.ts)
//   - WooCommerce post-checkout webhook (apps/api/src/routes/webhooks-wc.ts)
//
// Single-card vs multi-card branching is the WC contribution from
// _plans/2026-06-22-wc-post-purchase-sms.md.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPostSaleSmsBody } from './post-sale-sms';

// 16-char base64url token (12 random bytes), matching the new short-link
// format from _plans/2026-06-22-sms-short-link.md.
const RAW_TOKEN = 'AbCdEfGhIjKlMnOp';
const LINK = `https://my.memesh.co.il/c/${RAW_TOKEN}`;

test('buildPostSaleSmsBody: single card with expiry → POS-style body with count, date, link', () => {
  const body = buildPostSaleSmsBody({
    cards: [{ totalEntries: 12, expiresAt: new Date('2026-12-31T22:00:00.000Z') }],
    link: LINK,
  });
  assert.match(body, /הכרטיסייה שלך ב-Memesh נוצרה!/);
  assert.match(body, /12 כניסות/);
  assert.match(body, /תוקף עד 2026-12-31/);
  // Wording aligned with the multi-card branch and Yanay's 2026-06-22 UX
  // feedback: the CTA points at the personal area, not at the card itself.
  assert.match(body, /לצפייה באזור האישי: /);
  assert.equal(body.includes('צפייה בכרטיסייה:'), false, 'legacy wording must be gone');
  assert.ok(body.includes(LINK), 'SMS body must contain the full magic link');
});

test('buildPostSaleSmsBody: single card with no expiry renders "(ללא תפוגה)" instead of a date', () => {
  const body = buildPostSaleSmsBody({
    cards: [{ totalEntries: 6, expiresAt: null }],
    link: LINK,
  });
  assert.match(body, /6 כניסות \(ללא תפוגה\)/);
  assert.equal(body.includes('תוקף עד'), false, 'no expiry date when expiresAt is null');
  assert.ok(body.includes(LINK), 'magic link is still present');
});

test('buildPostSaleSmsBody: the link is embedded verbatim — no URL encoding, no trailing punctuation that would break tap-to-open', () => {
  const body = buildPostSaleSmsBody({
    cards: [{ totalEntries: 1, expiresAt: null }],
    link: LINK,
  });
  // The URL must be the last meaningful payload so a phone's URL detector
  // captures it cleanly. Specifically: nothing after the token.
  assert.ok(body.endsWith(LINK), `body must end with the magic link, got: ${body}`);
});

test('buildPostSaleSmsBody: a different totalEntries renders without leaking other state', () => {
  const body = buildPostSaleSmsBody({
    cards: [{ totalEntries: 50, expiresAt: new Date('2027-01-15T08:00:00.000Z') }],
    link: 'https://example.test/c/abc',
  });
  assert.match(body, /50 כניסות/);
  assert.match(body, /תוקף עד 2027-01-15/);
  assert.match(body, /https:\/\/example\.test\/c\/abc/);
});

test('buildPostSaleSmsBody: 2 cards → generic "נוצרו 2 כרטיסיות" body, NO per-card claim', () => {
  // Multi-card branch from the WC plan: showing one card's count + expiry
  // when the customer bought two cards would be a false at-a-glance claim.
  // Body must steer to the personal area instead.
  const body = buildPostSaleSmsBody({
    cards: [
      { totalEntries: 12, expiresAt: new Date('2027-06-22T22:00:00.000Z') },
      { totalEntries: 6, expiresAt: null },
    ],
    link: LINK,
  });
  assert.match(body, /נוצרו 2 כרטיסיות חדשות ב-Memesh!/);
  assert.match(body, /לצפייה באזור האישי: /);
  assert.equal(body.includes('כניסות'), false, 'multi-card body must NOT make per-card entry claims');
  assert.equal(body.includes('תוקף עד'), false, 'multi-card body must NOT mention a single card expiry');
  assert.ok(body.endsWith(LINK), 'link is still the last payload');
});

test('buildPostSaleSmsBody: 3+ cards renders the count generically', () => {
  const body = buildPostSaleSmsBody({
    cards: [
      { totalEntries: 12, expiresAt: null },
      { totalEntries: 12, expiresAt: null },
      { totalEntries: 12, expiresAt: null },
    ],
    link: LINK,
  });
  assert.match(body, /נוצרו 3 כרטיסיות חדשות/);
});

test('buildPostSaleSmsBody: empty cards array falls back to a safe link-only body (defensive)', () => {
  // Callers shouldn't invoke this with zero cards, but if they ever do
  // (e.g. processor returns 'processed' with cardsSummary: []), the customer
  // still gets a working magic link rather than a thrown exception.
  const body = buildPostSaleSmsBody({ cards: [], link: LINK });
  assert.match(body, /הכרטיסייה שלך ב-Memesh מוכנה!/);
  assert.match(body, /לצפייה באזור האישי: /);
  assert.ok(body.endsWith(LINK));
});
