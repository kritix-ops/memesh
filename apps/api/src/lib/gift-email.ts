/**
 * Gift card email builders + fire helpers. Three distinct emails, one shared
 * RTL layout. Mirrors the shape of `post-purchase-email.ts` so a future
 * reviewer can diff the gift channel against the regular post-purchase one.
 *
 * Emails:
 *   - Recipient gift email — variant "magic" when the recipient was already
 *     a Memesh customer (direct-mint branch), variant "claim" when they are
 *     brand new (pending-claim branch). Same copy fields apart from the CTA
 *     label, which differs per variant.
 *   - Buyer confirmation email — sent at WC checkout time on both branches.
 *     No magic link (the buyer is not the recipient).
 *   - Buyer claim-notification email — sent when the recipient finally
 *     claims a pending gift (phase 5 / route layer fires this; helper lives
 *     here so all gift email code is in one place).
 *
 * RTL handling: belt-and-suspenders. Every email carries `dir="rtl"` AS AN
 * HTML ATTRIBUTE on every text-bearing element AND inline `text-align:right;
 * direction:rtl;` as CSS. Gmail strips the outer html dir; some clients
 * ignore inline CSS. Doing both makes Hebrew render right-aligned across
 * Gmail web/mobile, Outlook, Apple Mail. Same approach validated for the
 * existing post-purchase email (Yanay 2026-06-24).
 */

import { createHash } from 'node:crypto';
import {
  getCardSettings,
  mintHandoffToken,
  renderGiftTemplate,
} from '@memesh/db';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';
import { emailProvider } from './email.js';

type AnyPgDatabase = PgDatabase<any, any, any>;

// A gift email may sit unread for days — the recipient might be on holiday,
// the buyer might have sent it weeks before a birthday. The magic-link token
// matches the long TTL the gift email itself uses (24h is too short).
const GIFT_MAGIC_LINK_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shared layout
// ---------------------------------------------------------------------------

interface RenderedSection {
  subject: string;
  headline: string;
  intro: string;
  ctaText?: string;
  ctaUrl?: string;
  footerNote: string;
}

function buildGiftEmailHtml(input: RenderedSection & { logoUrl: string }): string {
  const escSubject = escapeHtmlText(input.subject);
  const escHeadline = escapeHtmlText(input.headline);
  const escIntro = escapeHtmlText(input.intro);
  const escFooter = escapeHtmlText(input.footerNote);
  const escLogo = escapeHtmlAttr(input.logoUrl);
  const ctaBlock =
    input.ctaText && input.ctaUrl
      ? `<tr>
              <td style="padding:0 32px 24px 32px;" align="center">
                <a href="${escapeHtmlAttr(input.ctaUrl)}" style="display:inline-block;background:#f6a96e;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;">${escapeHtmlText(input.ctaText)}</a>
              </td>
            </tr>
            <tr>
              <td dir="rtl" style="padding:0 32px 24px 32px;font-size:12px;line-height:1.5;color:#8a8f95;direction:rtl;text-align:right;">
                <p dir="rtl" style="margin:0 0 8px 0;direction:rtl;text-align:right;">אם הכפתור לא נפתח, אפשר להעתיק את הקישור הבא:</p>
                <p style="margin:0;word-break:break-all;direction:ltr;text-align:left;"><a href="${escapeHtmlAttr(input.ctaUrl)}" style="color:#a98d7d;text-decoration:underline;">${escapeHtmlText(input.ctaUrl)}</a></p>
              </td>
            </tr>`
      : '';

  return `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escSubject}</title>
  </head>
  <body dir="rtl" style="margin:0;padding:0;background:#fff8f1;font-family:'Assistant','Segoe UI','Helvetica Neue',Arial,sans-serif;color:#2d3436;direction:rtl;text-align:right;">
    <table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff8f1;padding:32px 16px;direction:rtl;">
      <tr>
        <td align="center">
          <table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:16px;box-shadow:0 6px 24px rgba(45,52,54,0.08);direction:rtl;">
            <tr>
              <td style="padding:32px 32px 8px 32px;" align="center">
                <a href="https://memesh.co.il" style="display:inline-block;text-decoration:none;border:0;outline:none;">
                  <img src="${escLogo}" alt="Memesh" width="200" style="display:block;width:200px;height:auto;border:0;outline:none;text-decoration:none;" />
                </a>
              </td>
            </tr>
            <tr>
              <td dir="rtl" style="padding:8px 32px 8px 32px;direction:rtl;text-align:center;">
                <h1 dir="rtl" style="margin:12px 0 8px 0;font-size:24px;font-weight:700;color:#2d3436;line-height:1.3;text-align:center;direction:rtl;">${escHeadline}</h1>
              </td>
            </tr>
            <tr>
              <td dir="rtl" style="padding:0 32px 16px 32px;font-size:16px;line-height:1.6;color:#2d3436;direction:rtl;text-align:right;">
                <p dir="rtl" style="margin:0 0 24px 0;color:#5a6168;direction:rtl;text-align:right;">${escIntro}</p>
              </td>
            </tr>
            ${ctaBlock}
            <tr>
              <td dir="rtl" style="padding:0 32px 28px 32px;font-size:12px;color:#a98d7d;border-top:1px solid #f0eae5;direction:rtl;text-align:right;">
                <p dir="rtl" style="margin:16px 0 0 0;direction:rtl;text-align:right;">${escFooter}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildGiftEmailText(input: RenderedSection): string {
  const parts: string[] = [input.headline, '', input.intro, ''];
  if (input.ctaText && input.ctaUrl) {
    parts.push(`${input.ctaText}: ${input.ctaUrl}`, '');
  }
  parts.push(input.footerNote);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Recipient gift email
// ---------------------------------------------------------------------------

export interface BuildGiftRecipientEmailInput {
  buyerFirstName: string;
  recipientFirstName: string;
  /** Magic link (existing customer path) or claim URL (new recipient path). */
  ctaUrl: string;
  variant: 'magic' | 'claim';
  logoUrl: string;
  copy: {
    subject: string;
    headline: string;
    intro: string;
    magicCtaText: string;
    claimCtaText: string;
    footerNote: string;
  };
}

export interface BuiltGiftEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildGiftRecipientEmailBody(
  input: BuildGiftRecipientEmailInput,
): BuiltGiftEmail {
  const vars = {
    buyerFirstName: input.buyerFirstName,
    recipientFirstName: input.recipientFirstName,
  };
  const subject = renderGiftTemplate(input.copy.subject, vars);
  const headline = renderGiftTemplate(input.copy.headline, vars);
  const intro = renderGiftTemplate(input.copy.intro, vars);
  const ctaText =
    input.variant === 'magic'
      ? input.copy.magicCtaText
      : input.copy.claimCtaText;
  const section: RenderedSection = {
    subject,
    headline,
    intro,
    ctaText,
    ctaUrl: input.ctaUrl,
    footerNote: input.copy.footerNote,
  };
  return {
    subject,
    html: buildGiftEmailHtml({ ...section, logoUrl: input.logoUrl }),
    text: buildGiftEmailText(section),
  };
}

// ---------------------------------------------------------------------------
// Buyer confirmation email (at order time)
// ---------------------------------------------------------------------------

export interface BuildGiftBuyerEmailInput {
  buyerFirstName: string;
  recipientFirstName: string;
  logoUrl: string;
  copy: {
    subject: string;
    headline: string;
    intro: string;
    footerNote: string;
  };
}

export function buildGiftBuyerEmailBody(
  input: BuildGiftBuyerEmailInput,
): BuiltGiftEmail {
  const vars = {
    buyerFirstName: input.buyerFirstName,
    recipientFirstName: input.recipientFirstName,
  };
  const subject = renderGiftTemplate(input.copy.subject, vars);
  const headline = renderGiftTemplate(input.copy.headline, vars);
  const intro = renderGiftTemplate(input.copy.intro, vars);
  const section: RenderedSection = {
    subject,
    headline,
    intro,
    footerNote: input.copy.footerNote,
  };
  return {
    subject,
    html: buildGiftEmailHtml({ ...section, logoUrl: input.logoUrl }),
    text: buildGiftEmailText(section),
  };
}

// ---------------------------------------------------------------------------
// Buyer claim-notification email (fires when recipient claims a pending gift)
// ---------------------------------------------------------------------------

export interface BuildGiftBuyerClaimEmailInput {
  buyerFirstName: string;
  recipientFirstName: string;
  logoUrl: string;
  copy: {
    subject: string;
    headline: string;
    intro: string;
    footerNote: string;
  };
}

export function buildGiftBuyerClaimEmailBody(
  input: BuildGiftBuyerClaimEmailInput,
): BuiltGiftEmail {
  const vars = {
    buyerFirstName: input.buyerFirstName,
    recipientFirstName: input.recipientFirstName,
  };
  const subject = renderGiftTemplate(input.copy.subject, vars);
  const headline = renderGiftTemplate(input.copy.headline, vars);
  const intro = renderGiftTemplate(input.copy.intro, vars);
  const section: RenderedSection = {
    subject,
    headline,
    intro,
    footerNote: input.copy.footerNote,
  };
  return {
    subject,
    html: buildGiftEmailHtml({ ...section, logoUrl: input.logoUrl }),
    text: buildGiftEmailText(section),
  };
}

// ---------------------------------------------------------------------------
// Fire helpers — fire-and-log, never throw.
// ---------------------------------------------------------------------------

function logoUrl(): string {
  // Memesh logo is byte-identical to logo/memeshnoback.png; served by the
  // customer Vercel project at /og-image.png since commit dd80d36.
  return `${env.CUSTOMER_BASE_URL}/og-image.png`;
}

export interface FireGiftRecipientMagicEmailInput {
  /** The recipient's customer id; used to mint the wc_checkout handoff token. */
  recipientCustomerId: string;
  recipientEmail: string;
  recipientFirstName: string;
  buyerFirstName: string;
  /** WC order id for token orderRef + audit logs. */
  orderId: string;
  log: FastifyBaseLogger;
}

/**
 * Fire the recipient gift email — magic-link variant (direct-mint branch).
 * Recipient is an existing Memesh customer; we mint a long-TTL handoff
 * token that lands them straight in the customer area with the gift card
 * visible. Single-use, same handoff token machinery the regular
 * post-purchase email uses.
 */
export async function fireGiftRecipientMagicEmail(
  db: AnyPgDatabase,
  input: FireGiftRecipientMagicEmailInput,
): Promise<void> {
  try {
    const settings = await getCardSettings(db);
    if (!settings.emailOnPurchase) {
      input.log.info(
        { orderId: input.orderId },
        '[wc gift] recipient_magic skipped: emailOnPurchase disabled',
      );
      return;
    }

    const minted = await mintHandoffToken(db, {
      customerId: input.recipientCustomerId,
      source: 'wc_checkout',
      orderRef: input.orderId,
      ttlMs: GIFT_MAGIC_LINK_TTL_MS,
    });
    const tokenHashPrefix = createHash('sha256')
      .update(minted.raw)
      .digest('hex')
      .slice(0, 8);
    const link = `${env.CUSTOMER_BASE_URL}/c/${minted.raw}`;
    const { subject, html, text } = buildGiftRecipientEmailBody({
      buyerFirstName: input.buyerFirstName,
      recipientFirstName: input.recipientFirstName,
      ctaUrl: link,
      variant: 'magic',
      logoUrl: logoUrl(),
      copy: {
        subject: settings.giftRecipientEmailSubject,
        headline: settings.giftRecipientEmailHeadline,
        intro: settings.giftRecipientEmailIntro,
        magicCtaText: settings.giftRecipientEmailMagicCtaText,
        claimCtaText: settings.giftRecipientEmailClaimCtaText,
        footerNote: settings.giftRecipientEmailFooterNote,
      },
    });
    const res = await emailProvider.send({
      to: input.recipientEmail,
      subject,
      html,
      text,
    });
    if (res.ok) {
      input.log.info(
        { orderId: input.orderId, tokenHashPrefix, providerId: res.id ?? null },
        '[wc gift] recipient_magic sent',
      );
    } else {
      input.log.warn(
        { orderId: input.orderId, tokenHashPrefix, error: res.error },
        '[wc gift] recipient_magic provider error',
      );
    }
  } catch (err) {
    input.log.warn(
      { err, orderId: input.orderId },
      '[wc gift] recipient_magic failed silently',
    );
  }
}

export interface FireGiftRecipientClaimEmailInput {
  recipientEmail: string;
  recipientFirstName: string;
  buyerFirstName: string;
  /** Raw claim token — embedded in the URL on the recipient's claim page. */
  rawClaimToken: string;
  orderId: string;
  log: FastifyBaseLogger;
}

/**
 * Fire the recipient gift email — claim-link variant (pending-claim branch).
 * Recipient is brand new; the CTA links to the customer-area claim page
 * where they verify their phone via OTP and the gift is materialized.
 */
export async function fireGiftRecipientClaimEmail(
  db: AnyPgDatabase,
  input: FireGiftRecipientClaimEmailInput,
): Promise<void> {
  try {
    const settings = await getCardSettings(db);
    if (!settings.emailOnPurchase) {
      input.log.info(
        { orderId: input.orderId },
        '[wc gift] recipient_claim skipped: emailOnPurchase disabled',
      );
      return;
    }
    const tokenHashPrefix = createHash('sha256')
      .update(input.rawClaimToken)
      .digest('hex')
      .slice(0, 8);
    const link = `${env.CUSTOMER_BASE_URL}/gift/${input.rawClaimToken}`;
    const { subject, html, text } = buildGiftRecipientEmailBody({
      buyerFirstName: input.buyerFirstName,
      recipientFirstName: input.recipientFirstName,
      ctaUrl: link,
      variant: 'claim',
      logoUrl: logoUrl(),
      copy: {
        subject: settings.giftRecipientEmailSubject,
        headline: settings.giftRecipientEmailHeadline,
        intro: settings.giftRecipientEmailIntro,
        magicCtaText: settings.giftRecipientEmailMagicCtaText,
        claimCtaText: settings.giftRecipientEmailClaimCtaText,
        footerNote: settings.giftRecipientEmailFooterNote,
      },
    });
    const res = await emailProvider.send({
      to: input.recipientEmail,
      subject,
      html,
      text,
    });
    if (res.ok) {
      input.log.info(
        { orderId: input.orderId, tokenHashPrefix, providerId: res.id ?? null },
        '[wc gift] recipient_claim sent',
      );
    } else {
      input.log.warn(
        { orderId: input.orderId, tokenHashPrefix, error: res.error },
        '[wc gift] recipient_claim provider error',
      );
    }
  } catch (err) {
    input.log.warn(
      { err, orderId: input.orderId },
      '[wc gift] recipient_claim failed silently',
    );
  }
}

export interface FireGiftBuyerEmailInput {
  buyerEmail: string;
  buyerFirstName: string;
  recipientFirstName: string;
  orderId: string;
  log: FastifyBaseLogger;
}

/** Buyer confirmation email — sent at order time on both gift branches. */
export async function fireGiftBuyerEmail(
  db: AnyPgDatabase,
  input: FireGiftBuyerEmailInput,
): Promise<void> {
  try {
    const settings = await getCardSettings(db);
    if (!settings.emailOnPurchase) {
      input.log.info(
        { orderId: input.orderId },
        '[wc gift] buyer skipped: emailOnPurchase disabled',
      );
      return;
    }
    const { subject, html, text } = buildGiftBuyerEmailBody({
      buyerFirstName: input.buyerFirstName,
      recipientFirstName: input.recipientFirstName,
      logoUrl: logoUrl(),
      copy: {
        subject: settings.giftBuyerEmailSubject,
        headline: settings.giftBuyerEmailHeadline,
        intro: settings.giftBuyerEmailIntro,
        footerNote: settings.giftBuyerEmailFooterNote,
      },
    });
    const res = await emailProvider.send({
      to: input.buyerEmail,
      subject,
      html,
      text,
    });
    if (res.ok) {
      input.log.info(
        { orderId: input.orderId, providerId: res.id ?? null },
        '[wc gift] buyer sent',
      );
    } else {
      input.log.warn(
        { orderId: input.orderId, error: res.error },
        '[wc gift] buyer provider error',
      );
    }
  } catch (err) {
    input.log.warn(
      { err, orderId: input.orderId },
      '[wc gift] buyer failed silently',
    );
  }
}

export interface FireGiftBuyerClaimEmailInput {
  buyerEmail: string;
  buyerFirstName: string;
  recipientFirstName: string;
  orderId: string;
  log: FastifyBaseLogger;
}

/**
 * Buyer claim-notification email — fires when the recipient finally claims a
 * pending gift. Wired into the claim route in phase 5.
 */
export async function fireGiftBuyerClaimEmail(
  db: AnyPgDatabase,
  input: FireGiftBuyerClaimEmailInput,
): Promise<void> {
  try {
    const settings = await getCardSettings(db);
    if (!settings.emailOnPurchase) {
      input.log.info(
        { orderId: input.orderId },
        '[wc gift] buyer_claim skipped: emailOnPurchase disabled',
      );
      return;
    }
    if (!settings.giftBuyerNotifyOnClaim) {
      input.log.info(
        { orderId: input.orderId },
        '[wc gift] buyer_claim skipped: giftBuyerNotifyOnClaim disabled',
      );
      return;
    }
    const { subject, html, text } = buildGiftBuyerClaimEmailBody({
      buyerFirstName: input.buyerFirstName,
      recipientFirstName: input.recipientFirstName,
      logoUrl: logoUrl(),
      copy: {
        subject: settings.giftBuyerClaimEmailSubject,
        headline: settings.giftBuyerClaimEmailHeadline,
        intro: settings.giftBuyerClaimEmailIntro,
        footerNote: settings.giftBuyerClaimEmailFooterNote,
      },
    });
    const res = await emailProvider.send({
      to: input.buyerEmail,
      subject,
      html,
      text,
    });
    if (res.ok) {
      input.log.info(
        { orderId: input.orderId, providerId: res.id ?? null },
        '[wc gift] buyer_claim sent',
      );
    } else {
      input.log.warn(
        { orderId: input.orderId, error: res.error },
        '[wc gift] buyer_claim provider error',
      );
    }
  } catch (err) {
    input.log.warn(
      { err, orderId: input.orderId },
      '[wc gift] buyer_claim failed silently',
    );
  }
}

// ---------------------------------------------------------------------------
// HTML escaping (mirrors post-purchase-email.ts)
// ---------------------------------------------------------------------------

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
