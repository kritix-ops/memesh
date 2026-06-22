/**
 * Fire-and-log helper for the post-purchase SMS that goes out after a
 * WooCommerce checkout creates one or more punch cards. Yanay 2026-06-22:
 * customers who buy a כרטיסיה online should get an SMS with a magic link
 * into my.memesh.co.il, in addition to the WP→browser redirect that
 * already happens on the thank-you page.
 *
 * Called from BOTH code paths that can create cards from a WC order:
 *   - POST /webhooks/woocommerce/order (the async webhook)
 *   - POST /auth/customer/wc-handoff/mint (the inline call WP makes on
 *     the thank-you page)
 *
 * Dedup is structural: each caller only invokes this helper when
 * `result.cardsCreated.length > 0`. The advisory lock + `countCardsForWcOrder`
 * in the processor guarantees that exactly one of the two paths will
 * create the cards for a given order — the other gets `cardsCreated: []`
 * and skips the SMS.
 *
 * See _plans/2026-06-22-wc-post-purchase-sms.md.
 *
 * TRANSACTIONAL CLASSIFICATION — same carve-out the POS post-sale SMS
 * relies on (Israeli Comm. Act amend. 40 / חוק התקשורת תיקון 40): the
 * SMS confirms a paid transaction the customer just completed. We
 * deliberately bypass:
 *   - `marketingConsentAt` (the legal gate for marketing only)
 *   - quiet hours (a customer who just paid wants confirmation NOW)
 * What we honor:
 *   - `smsOnPurchase` — operator master switch for "send any post-sale
 *     SMS at all" (cost control, dev envs, brand preference). The same
 *     switch the POS path honors.
 */

import { createHash } from 'node:crypto';
import { getCardSettings, mintHandoffToken } from '@memesh/db';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';
import { buildPostSaleSmsBody, type PostSaleSmsCard } from './post-sale-sms.js';
import { smsProvider } from './sms.js';

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
// Same pattern processWcOrderWebhook uses so the helper is unit-testable
// against an isolated PGlite instance.
type AnyPgDatabase = PgDatabase<any, any, any>;

// SMS handoff tokens live longer than the 5-min default the browser-redirect
// path uses. An SMS may sit unread on the customer's phone for hours, so the
// magic link still needs to work when they get around to tapping it. Same
// rationale as the POS path (cards.ts).
const WC_SMS_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

export interface FireWcPostPurchaseSmsInput {
  customerId: string;
  /** Canonical 05XXXXXXXX form. The processor normalizes before returning. */
  customerPhone: string;
  /** WooCommerce order id, used as the token's orderRef and in logs. */
  orderId: string;
  /** Per-card data for the SMS body. Order matches cardsCreated. */
  cards: ReadonlyArray<PostSaleSmsCard>;
  log: FastifyBaseLogger;
}

/**
 * Fire the WC post-purchase SMS. Never throws; all failures are swallowed
 * and logged so a Pulseem hiccup cannot fail the upstream operation
 * (webhook 200 response or mint endpoint token return).
 *
 * Implementation mirrors the POS post-sale block in cards.ts so a future
 * reviewer can compare the two paths line-by-line.
 */
export async function fireWcPostPurchaseSms(
  db: AnyPgDatabase,
  input: FireWcPostPurchaseSmsInput,
): Promise<void> {
  try {
    const settings = await getCardSettings(db);
    if (!settings.smsOnPurchase) {
      input.log.info(
        { orderId: input.orderId, cardsCount: input.cards.length },
        '[wc post-sale] skipped: smsOnPurchase disabled',
      );
      return;
    }

    const minted = await mintHandoffToken(db, {
      customerId: input.customerId,
      source: 'wc_checkout',
      orderRef: input.orderId,
      ttlMs: WC_SMS_HANDOFF_TTL_MS,
    });
    const tokenHashPrefix = createHash('sha256')
      .update(minted.raw)
      .digest('hex')
      .slice(0, 8);
    input.log.info(
      {
        orderId: input.orderId,
        customerId: input.customerId,
        tokenHashPrefix,
        expiresAt: minted.expiresAt.toISOString(),
      },
      '[wc post-sale] minted handoff token',
    );

    // Short-link path — see _plans/2026-06-22-sms-short-link.md. The
    // 16-char token + /c/ path roughly halves the URL length, which Yanay
    // flagged as visually noisy in the first SMS he received on 2026-06-22.
    // Link is https in production because config.ts refuses to boot when
    // CUSTOMER_BASE_URL is http:// or localhost in NODE_ENV=production.
    const link = `${env.CUSTOMER_BASE_URL}/c/${minted.raw}`;
    const body = buildPostSaleSmsBody({ cards: input.cards, link });

    const res = await smsProvider.send({ to: input.customerPhone, body });
    if (res.ok) {
      input.log.info(
        { orderId: input.orderId, tokenHashPrefix, providerId: res.id ?? null },
        '[wc post-sale] sms sent',
      );
    } else {
      input.log.warn(
        { orderId: input.orderId, tokenHashPrefix, error: res.error },
        '[wc post-sale] sms provider error',
      );
    }
  } catch (err) {
    input.log.warn(
      { err, orderId: input.orderId },
      '[wc post-sale] sms failed silently',
    );
  }
}
