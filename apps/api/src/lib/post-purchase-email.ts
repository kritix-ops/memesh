/**
 * Fire-and-log helper for the post-purchase email that goes out alongside
 * the SMS after a card is created. Mirrors `fireWcPostPurchaseSms` shape so
 * a future reviewer can compare the two channels side-by-side. Both helpers
 * are invoked from the same three trigger paths (POST /cards POS sale, WC
 * webhook, WC inline mint endpoint) when `cardsCreated.length > 0`.
 *
 * Design decisions locked with Yoav on 2026-06-23:
 *   - Provider: Pulseem (vendor consolidation with the SMS account)
 *   - Channels: send to both SMS + email when both addresses present
 *   - Tokens: each channel gets its OWN handoff token so the customer can
 *     tap either without seeing an "already used" error on the second tap
 *
 * See _plans/2026-06-23-post-purchase-email.md for the full design,
 * security analysis, and Pulseem API verification.
 *
 * TRANSACTIONAL CLASSIFICATION — same Israeli Comm. Act amend. 40
 * carve-out the SMS path relies on. We deliberately bypass:
 *   - `marketingConsentAt` (the legal gate for marketing only)
 *   - quiet hours (the customer just paid; they want confirmation NOW)
 * What we honor:
 *   - `emailOnPurchase` operator master switch (cost control, brand
 *     preference, dev envs)
 *   - `customer.email` being present (skip silently when null)
 */

import { createHash } from 'node:crypto';
import { getCardSettings, mintHandoffToken } from '@memesh/db';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';
import { emailProvider } from './email.js';
import type { PostSaleSmsCard } from './post-sale-sms.js';

type AnyPgDatabase = PgDatabase<any, any, any>;

// Same long TTL as the SMS handoff token — an email may sit unread for
// hours, sometimes a full day. The magic link must still resolve when the
// customer finally taps it. Single-use semantics still apply server-side.
const POST_PURCHASE_EMAIL_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

export interface FirePostPurchaseEmailInput {
  customerId: string;
  /** Customer email (we check for non-null here so callers don't have to). */
  customerEmail: string | null;
  /** Display name for the "to" line, e.g. `${firstName} ${lastName}`. */
  customerFirstName: string;
  /** Source of the sale: 'wc_checkout' (online) or 'pos_sell' (cashier). */
  source: 'wc_checkout' | 'pos_sell';
  /** Order or card id used as the token's audit pointer. */
  orderRef: string;
  /** Per-card data shared with the SMS body builder. Order matches cardsCreated. */
  cards: ReadonlyArray<PostSaleSmsCard>;
  log: FastifyBaseLogger;
}

export async function firePostPurchaseEmail(
  db: AnyPgDatabase,
  input: FirePostPurchaseEmailInput,
): Promise<void> {
  try {
    if (!input.customerEmail) {
      input.log.info(
        { orderRef: input.orderRef, cardsCount: input.cards.length },
        '[post-sale email] skipped: no customer email',
      );
      return;
    }

    const settings = await getCardSettings(db);
    if (!settings.emailOnPurchase) {
      input.log.info(
        { orderRef: input.orderRef, cardsCount: input.cards.length },
        '[post-sale email] skipped: emailOnPurchase disabled',
      );
      return;
    }

    const minted = await mintHandoffToken(db, {
      customerId: input.customerId,
      source: input.source,
      orderRef: input.orderRef,
      ttlMs: POST_PURCHASE_EMAIL_HANDOFF_TTL_MS,
    });
    const tokenHashPrefix = createHash('sha256')
      .update(minted.raw)
      .digest('hex')
      .slice(0, 8);
    input.log.info(
      {
        orderRef: input.orderRef,
        customerId: input.customerId,
        tokenHashPrefix,
        expiresAt: minted.expiresAt.toISOString(),
      },
      '[post-sale email] minted handoff token',
    );

    const link = `${env.CUSTOMER_BASE_URL}/c/${minted.raw}`;
    const { subject, html, text } = buildPostPurchaseEmailBody({
      firstName: input.customerFirstName,
      cards: input.cards,
      link,
    });

    const res = await emailProvider.send({
      to: input.customerEmail,
      subject,
      text,
      html,
    });
    if (res.ok) {
      input.log.info(
        { orderRef: input.orderRef, tokenHashPrefix, providerId: res.id ?? null },
        '[post-sale email] sent',
      );
    } else {
      input.log.warn(
        { orderRef: input.orderRef, tokenHashPrefix, error: res.error },
        '[post-sale email] provider error',
      );
    }
  } catch (err) {
    input.log.warn(
      { err, orderRef: input.orderRef },
      '[post-sale email] failed silently',
    );
  }
}

// ---------------------------------------------------------------------------
// Body builder — exported so unit tests can pin down the Hebrew copy + the
// URL shape independently of the DB/provider plumbing.
// ---------------------------------------------------------------------------

export interface PostPurchaseEmailBody {
  subject: string;
  html: string;
  text: string;
}

export interface BuildPostPurchaseEmailBodyInput {
  /** Customer first name. Falls back to "לקוח/ה" when empty. */
  firstName: string;
  cards: ReadonlyArray<PostSaleSmsCard>;
  link: string;
}

const SAFE_FIRST_NAME_FALLBACK = 'לקוח/ה';

export function buildPostPurchaseEmailBody(
  input: BuildPostPurchaseEmailBodyInput,
): PostPurchaseEmailBody {
  const firstName = input.firstName.trim() || SAFE_FIRST_NAME_FALLBACK;
  const cardCount = input.cards.length;
  const isMulti = cardCount > 1;

  const subject = isMulti
    ? `${cardCount} כרטיסיות חדשות ב-Memesh`
    : `הכרטיסייה שלך ב-Memesh מוכנה`;

  const detailLine = (() => {
    if (cardCount === 0) {
      return 'הכרטיסייה שלך מוכנה לשימוש.';
    }
    if (cardCount === 1) {
      const c = input.cards[0]!;
      const expiry = c.expiresAt
        ? `, תוקף עד ${c.expiresAt.toISOString().slice(0, 10)}`
        : ' (ללא תפוגה)';
      return `הכרטיסייה החדשה שלך כוללת <strong>${c.totalEntries} כניסות${expiry}</strong>.`;
    }
    return `נוצרו עבורך <strong>${cardCount} כרטיסיות חדשות</strong>.`;
  })();

  const detailLineText = (() => {
    if (cardCount === 0) return 'הכרטיסייה שלך מוכנה לשימוש.';
    if (cardCount === 1) {
      const c = input.cards[0]!;
      const expiry = c.expiresAt
        ? `, תוקף עד ${c.expiresAt.toISOString().slice(0, 10)}`
        : ' (ללא תפוגה)';
      return `הכרטיסייה החדשה שלך כוללת ${c.totalEntries} כניסות${expiry}.`;
    }
    return `נוצרו עבורך ${cardCount} כרטיסיות חדשות.`;
  })();

  const escapedName = escapeHtmlText(firstName);
  const escapedLink = escapeHtmlAttr(input.link);

  // HTML body. Inline styles are the right call here — email clients
  // famously ignore <style> blocks, so every visual choice must be inlined.
  // Color palette + typography match the customer-area shell on
  // my.memesh.co.il so the email feels of-a-piece with the destination.
  const html = `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtmlText(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#fff8f1;font-family:'Assistant','Segoe UI','Helvetica Neue',Arial,sans-serif;color:#2d3436;">
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;">${escapeHtmlText(detailLineText)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff8f1;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:16px;box-shadow:0 6px 24px rgba(45,52,54,0.08);">
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <div style="font-size:14px;font-weight:600;letter-spacing:0.04em;color:#a98d7d;text-transform:uppercase;">Memesh</div>
                <h1 style="margin:12px 0 8px 0;font-size:24px;font-weight:700;color:#2d3436;line-height:1.3;">שלום ${escapedName}, הכרטיסייה שלך מוכנה!</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 8px 32px;font-size:16px;line-height:1.6;color:#2d3436;">
                <p style="margin:0 0 12px 0;">${detailLine}</p>
                <p style="margin:0 0 24px 0;color:#5a6168;">תודה שרכשת אצלנו — אנחנו מחכים לראותך.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;" align="center">
                <a href="${escapedLink}" style="display:inline-block;background:#f6a96e;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;">לצפייה באזור האישי</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;font-size:12px;line-height:1.5;color:#8a8f95;">
                <p style="margin:0 0 8px 0;">אם הכפתור לא נפתח, אפשר להעתיק את הקישור הבא:</p>
                <p style="margin:0;word-break:break-all;direction:ltr;text-align:left;"><a href="${escapedLink}" style="color:#a98d7d;text-decoration:underline;">${escapeHtmlText(input.link)}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px 32px;font-size:12px;color:#a98d7d;border-top:1px solid #f0eae5;">
                <p style="margin:16px 0 0 0;">הודעה זו נשלחה לאחר רכישה ב-Memesh. אין צורך להשיב אליה.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  // Plain-text fallback — Pulseem accepts HTML only, but the @memesh/email
  // contract still asks for a text body. Some clients (and accessibility
  // tools) prefer the text variant; building one explicitly is cheap.
  const text = [
    `שלום ${firstName}, הכרטיסייה שלך מוכנה!`,
    '',
    detailLineText,
    'תודה שרכשת אצלנו — אנחנו מחכים לראותך.',
    '',
    `לצפייה באזור האישי: ${input.link}`,
  ].join('\n');

  return { subject, html, text };
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
