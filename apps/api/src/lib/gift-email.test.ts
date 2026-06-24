// Pin env BEFORE any module that reads config.ts loads. Same setup the
// post-purchase-email.test.ts uses — gift-email.ts imports `env` from
// config.ts which Zod-validates these at module load.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';
process.env.SERVER_SECRET_KEY ??= 'test-server-secret-at-least-32-chars!!';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters!';
process.env.QR_KEY_ID ??= '1';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  buildGiftBuyerClaimEmailBody,
  buildGiftBuyerEmailBody,
  buildGiftRecipientEmailBody,
} = await import('./gift-email.js');

// ---------------------------------------------------------------------------
// Recipient gift email — magic variant
// ---------------------------------------------------------------------------

function recipientCopy() {
  return {
    subject: '{{buyerFirstName}} שלח/ה לך כרטיסיית מתנה!',
    headline: 'קיבלת מתנה!',
    intro: '{{buyerFirstName}} בחר/ה להעניק לך כרטיסיית מתנה ב-Memesh.',
    magicCtaText: 'פתחו את הכרטיסייה',
    claimCtaText: 'קבלו את המתנה',
    footerNote: 'יש לכם שאלות? נשמח לעזור — פנו אלינו בכל עת.',
  };
}

test('buildGiftRecipientEmailBody substitutes buyerFirstName and uses the magic CTA', () => {
  const out = buildGiftRecipientEmailBody({
    buyerFirstName: 'דנה',
    recipientFirstName: 'יואב',
    ctaUrl: 'https://my.memesh.co.il/c/abc123',
    variant: 'magic',
    logoUrl: 'https://my.memesh.co.il/og-image.png',
    copy: recipientCopy(),
  });

  assert.equal(out.subject, 'דנה שלח/ה לך כרטיסיית מתנה!');
  assert.match(out.html, /קיבלת מתנה!/);
  assert.match(out.html, /דנה בחר\/ה להעניק/);
  assert.match(out.html, /פתחו את הכרטיסייה/);
  assert.doesNotMatch(out.html, /קבלו את המתנה/);
  assert.match(out.html, /https:\/\/my\.memesh\.co\.il\/c\/abc123/);
});

test('buildGiftRecipientEmailBody (claim variant) uses the claim CTA + URL', () => {
  const out = buildGiftRecipientEmailBody({
    buyerFirstName: 'דנה',
    recipientFirstName: 'יואב',
    ctaUrl: 'https://my.memesh.co.il/gift/CLAIM-TOKEN',
    variant: 'claim',
    logoUrl: 'https://my.memesh.co.il/og-image.png',
    copy: recipientCopy(),
  });
  assert.match(out.html, /קבלו את המתנה/);
  assert.doesNotMatch(out.html, /פתחו את הכרטיסייה/);
  assert.match(out.html, /\/gift\/CLAIM-TOKEN/);
});

test('buildGiftRecipientEmailBody renders RTL belt-and-suspenders attributes', () => {
  const out = buildGiftRecipientEmailBody({
    buyerFirstName: 'דנה',
    recipientFirstName: 'יואב',
    ctaUrl: 'https://my.memesh.co.il/c/abc',
    variant: 'magic',
    logoUrl: 'https://my.memesh.co.il/og-image.png',
    copy: recipientCopy(),
  });
  // Outer html tag dir=rtl (the one Gmail web respects)
  assert.match(out.html, /<html lang="he" dir="rtl">/);
  // Body dir=rtl + inline text-align:right (the Gmail iOS / Outlook fallback)
  assert.match(out.html, /<body dir="rtl"[^>]*text-align:right/);
  // Every paragraph / heading carries dir=rtl + inline text-align (per the
  // post-purchase-email pattern that survived Yanay's 2026-06-24 audit).
  const dirRtlCount = (out.html.match(/dir="rtl"/g) ?? []).length;
  assert.ok(dirRtlCount >= 6, `expected ≥6 dir="rtl" attributes, got ${dirRtlCount}`);
  const textAlignRightCount = (out.html.match(/text-align:right/g) ?? []).length;
  assert.ok(
    textAlignRightCount >= 4,
    `expected ≥4 text-align:right occurrences, got ${textAlignRightCount}`,
  );
});

test('buildGiftRecipientEmailBody renders the logo image at width 200', () => {
  const out = buildGiftRecipientEmailBody({
    buyerFirstName: 'דנה',
    recipientFirstName: 'יואב',
    ctaUrl: 'https://my.memesh.co.il/c/abc',
    variant: 'magic',
    logoUrl: 'https://my.memesh.co.il/og-image.png',
    copy: recipientCopy(),
  });
  assert.match(out.html, /<img[^>]+src="https:\/\/my\.memesh\.co\.il\/og-image\.png"[^>]*width="200"/);
});

test('buildGiftRecipientEmailBody plain text fallback contains the link and the CTA label', () => {
  const out = buildGiftRecipientEmailBody({
    buyerFirstName: 'דנה',
    recipientFirstName: 'יואב',
    ctaUrl: 'https://my.memesh.co.il/c/abc',
    variant: 'magic',
    logoUrl: 'https://my.memesh.co.il/og-image.png',
    copy: recipientCopy(),
  });
  assert.match(out.text, /קיבלת מתנה!/);
  assert.match(out.text, /פתחו את הכרטיסייה: https:\/\/my\.memesh\.co\.il\/c\/abc/);
});

// ---------------------------------------------------------------------------
// Buyer confirmation email
// ---------------------------------------------------------------------------

function buyerCopy() {
  return {
    subject: 'הזמנת כרטיסיית מתנה ל-{{recipientFirstName}}',
    headline: 'תודה על המתנה!',
    intro: 'שלחנו ל-{{recipientFirstName}} מייל עם הכרטיסייה.',
    footerNote: 'נעדכן אותך כשהמתנה תיפתח על ידי הנמען/ת.',
  };
}

test('buildGiftBuyerEmailBody substitutes recipientFirstName and omits the CTA block', () => {
  const out = buildGiftBuyerEmailBody({
    buyerFirstName: 'דנה',
    recipientFirstName: 'יואב',
    logoUrl: 'https://my.memesh.co.il/og-image.png',
    copy: buyerCopy(),
  });
  assert.equal(out.subject, 'הזמנת כרטיסיית מתנה ל-יואב');
  assert.match(out.html, /שלחנו ל-יואב מייל/);
  // No CTA button → no "אם הכפתור לא נפתח" fallback paragraph.
  assert.doesNotMatch(out.html, /אם הכפתור לא נפתח/);
});

// ---------------------------------------------------------------------------
// Buyer claim-notification email
// ---------------------------------------------------------------------------

test('buildGiftBuyerClaimEmailBody substitutes recipientFirstName in subject + intro', () => {
  const out = buildGiftBuyerClaimEmailBody({
    buyerFirstName: 'דנה',
    recipientFirstName: 'יואב',
    logoUrl: 'https://my.memesh.co.il/og-image.png',
    copy: {
      subject: '{{recipientFirstName}} פתח/ה את המתנה שלך!',
      headline: 'המתנה נפתחה',
      intro: '{{recipientFirstName}} פתח/ה את הכרטיסייה שהענקת.',
      footerNote: 'הודעה זו נשלחה לאחר רכישה.',
    },
  });
  assert.equal(out.subject, 'יואב פתח/ה את המתנה שלך!');
  assert.match(out.html, /יואב פתח\/ה את הכרטיסייה/);
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

test('builder falls back to "לקוח/ה" when first-name placeholder is empty', () => {
  const out = buildGiftRecipientEmailBody({
    buyerFirstName: '',
    recipientFirstName: 'יואב',
    ctaUrl: 'https://my.memesh.co.il/c/abc',
    variant: 'magic',
    logoUrl: 'https://my.memesh.co.il/og-image.png',
    copy: recipientCopy(),
  });
  assert.match(out.subject, /לקוח\/ה שלח\/ה לך/);
});
