import { signCustomerToken } from '@memesh/auth';
import {
  consumeHandoffToken,
  customers,
  db,
  getCardSettings,
  mintHandoffToken,
  renderHandoffThankyou,
} from '@memesh/db';
import { normalizeIsraeliPhone } from '@memesh/sms';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { customerAuthConfig } from '../auth.js';
import { env } from '../config.js';
import { cookieScope } from '../lib/cookie-scope.js';
import {
  fireGiftBuyerEmail,
  fireGiftRecipientClaimEmail,
  fireGiftRecipientMagicEmail,
} from '../lib/gift-email.js';
import { firePostPurchaseEmail } from '../lib/post-purchase-email.js';
import { processWcOrderWebhook } from '../lib/wc-order-processor.js';
import { processRoundOrderWebhook } from '../lib/wc-round-processor.js';
import { fireWcPostPurchaseSms } from '../lib/wc-post-purchase-sms.js';
import { envKeyResolver } from '../qr.js';

// WooCommerce checkout → my.memesh.co.il auto-login handoff.
// See _plans/2026-06-21-wc-checkout-handoff-to-customer-api.md for the full
// design. Two endpoints:
//
//   POST /auth/customer/wc-handoff/mint    — called by the WP plugin only.
//     Authenticated via a static shared secret (WP_HANDOFF_SHARED_SECRET).
//     Returns an opaque single-use token + expiry. WP redirects the buyer to
//     https://my.memesh.co.il/checkout-complete?token=<raw>
//
//   POST /auth/customer/wc-handoff/verify  — called by the customer frontend.
//     Atomically consumes the token and sets the customer session cookie.
//     401 on any failure mode (replay, expired, unknown, garbage) — no
//     enumeration oracle.

const CUSTOMER_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const setCustomerCookie = (reply: FastifyReply, token: string): void => {
  // Mirrors the helper in customer-auth.ts so the cookie shape stays in sync
  // across the OTP path and the handoff path. Worth a small duplication
  // rather than a cross-file import — the function is six lines and
  // changes about once a year.
  reply.setCookie('customer_token', token, {
    ...cookieScope(),
    maxAge: CUSTOMER_SESSION_MAX_AGE_SEC,
  });
};

// Body for the mint endpoint. The optional `order` is the full WooCommerce
// order JSON; when present, the processor runs inline so the customer +
// punch cards exist by the time we try to mint a token for them. This is
// the same shape the existing /webhooks/woocommerce/order route accepts,
// so a future refactor can share the schema if it grows.
const mintSchema = z.object({
  orderId: z.string().min(1).max(64),
  phone: z.string().min(1).max(32).optional(),
  email: z.string().email().max(255).optional(),
  source: z.enum(['wc_checkout']),
  order: z.unknown().optional(),
});

const verifySchema = z.object({
  // Min 12 covers the new 16-char short tokens (12-byte base64url) AND the
  // legacy 43-char ones (32-byte base64url) still in flight during the
  // 24h tail after the 2026-06-22 short-link cutover. Max 100 stays as a
  // defense-in-depth cap against pathological inputs.
  token: z.string().min(12).max(100),
});

const constantTimeStringEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const tokenHashPrefix = (raw: string): string => {
  // Log a short prefix of the SHA-256 (not the raw token) so a successful
  // mint and the matching verify can be correlated in logs without ever
  // exposing the token itself.
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
};

export const wcHandoffRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/auth/customer/wc-handoff/mint',
    {
      // WP bursts during checkout flurries; 60/min is generous. The shared
      // secret is the real auth — rate limit is defense-in-depth.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      // Production guard: the feature is OFF unless the secret is set.
      if (!env.WP_HANDOFF_SHARED_SECRET) {
        request.log.error('[wc handoff mint] WP_HANDOFF_SHARED_SECRET not configured');
        return reply.code(503).send({ error: 'handoff_not_configured' });
      }

      // Verify Authorization: Bearer <shared-secret>.
      const auth = request.headers['authorization'];
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
        request.log.info('[wc handoff mint] missing or malformed Authorization');
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const presented = auth.slice('Bearer '.length);
      if (!constantTimeStringEqual(presented, env.WP_HANDOFF_SHARED_SECRET)) {
        request.log.info('[wc handoff mint] wrong shared secret');
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const parsed = mintSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      // If the WP plugin shipped the order payload, run the processor inline
      // so the customer + cards exist by the time we try to look them up.
      // The processor is idempotent — running it here is a no-op if the
      // webhook already processed this delivery, and creates rows otherwise.
      let processorDiag: { status: string; reason?: string; issues?: unknown } | undefined;
      if (parsed.data.order !== undefined) {
        const result = await processWcOrderWebhook(db, {
          deliveryId: `wc-handoff-${parsed.data.orderId}`,
          topic: 'order.updated',
          payload: parsed.data.order,
          resolver: envKeyResolver,
        });
        // Capture the issues/reason on failure so the next attempt can
        // diagnose without another log-chase round-trip.
        processorDiag = {
          status: result.status,
          ...(result.status === 'invalid_payload' && { issues: result.issues }),
          ...(result.status === 'failure' && { reason: result.reason }),
        };
        request.log.info(
          { orderId: parsed.data.orderId, ...processorDiag },
          '[wc handoff inline-processor]',
        );
        // Fire post-purchase SMS when THIS inline call actually created
        // cards. The mint endpoint is the common case where cards are
        // created first (WP thank-you page hook runs before the async
        // webhook arrives), so SMS firing here is the typical path. The
        // webhook arriving later returns processed with cardsCreated: []
        // and naturally skips. See _plans/2026-06-22-wc-post-purchase-sms.md.
        if (result.status === 'processed' && result.cardsCreated.length > 0) {
          // Mint endpoint is the common case (WP thank-you page runs
          // before the async webhook arrives), so this is where SMS +
          // email typically fire for WC orders. Two channels in parallel,
          // each with their own handoff token. See
          // _plans/2026-06-23-post-purchase-email.md.
          void fireWcPostPurchaseSms(db, {
            customerId: result.customerId,
            customerPhone: result.customerPhone,
            orderId: result.orderId,
            cards: result.cardsSummary,
            log: request.log,
          });
          void firePostPurchaseEmail(db, {
            customerId: result.customerId,
            customerEmail: result.customerEmail,
            customerFirstName: result.customerFirstName,
            source: 'wc_checkout',
            orderRef: result.orderId,
            cards: result.cardsSummary,
            log: request.log,
          });
        }
        // Gift-card branches: the inline mint path is the first surface
        // that creates cards / pending claims for a gift order (WP thank-you
        // runs before the async webhook), so the gift emails fire here in
        // the common case. The async webhook re-running this code sees
        // either cardsCreated:[] (direct-mint already done) or
        // alreadyExisted:true (pending already minted) and skips email
        // sending, preserving "exactly one email per real purchase".
        if (
          result.status === 'processed_gift_direct' &&
          result.cardsCreated.length > 0 &&
          result.recipientCustomerEmail
        ) {
          void fireGiftRecipientMagicEmail(db, {
            recipientCustomerId: result.recipientCustomerId,
            recipientEmail: result.recipientCustomerEmail,
            recipientFirstName: result.recipientFirstName,
            buyerFirstName: result.buyerFirstName,
            orderId: result.orderId,
            log: request.log,
          });
          void fireGiftBuyerEmail(db, {
            buyerEmail: result.buyerEmail,
            buyerFirstName: result.buyerFirstName,
            recipientFirstName: result.recipientFirstName,
            orderId: result.orderId,
            log: request.log,
          });
        }
        if (
          result.status === 'processed_gift_pending' &&
          !result.alreadyExisted &&
          result.rawClaimToken
        ) {
          void fireGiftRecipientClaimEmail(db, {
            recipientEmail: result.recipientEmail,
            recipientFirstName: result.recipientFirstName,
            buyerFirstName: result.buyerFirstName,
            rawClaimToken: result.rawClaimToken,
            orderId: result.orderId,
            log: request.log,
          });
          void fireGiftBuyerEmail(db, {
            buyerEmail: result.buyerEmail,
            buyerFirstName: result.buyerFirstName,
            recipientFirstName: result.recipientFirstName,
            orderId: result.orderId,
            log: request.log,
          });
        }
      }

      // Rounds: the handoff (thank-you page) is the PRIMARY mint path per §4.2,
      // so a round booking's barcode is ready the moment the customer lands in
      // their personal area — not seconds later when the async webhook catches
      // up. mintBooking is idempotent per hold id, so the webhook re-running
      // this is a harmless no-op. A round-mint exception is logged, not fatal:
      // the card handoff already stands and the webhook is the safety net.
      if (parsed.data.order !== undefined) {
        try {
          const roundResult = await processRoundOrderWebhook(db, {
            topic: 'order.updated',
            payload: parsed.data.order,
            resolver: envKeyResolver,
          });
          if (roundResult.status === 'processed') {
            request.log.info(
              {
                orderId: roundResult.orderId,
                minted: roundResult.minted.length,
                failed: roundResult.failed.length,
                companion: roundResult.companion,
              },
              '[wc handoff rounds] processed',
            );
            if (roundResult.failed.length > 0) {
              request.log.warn(
                { orderId: roundResult.orderId, failed: roundResult.failed },
                '[wc handoff rounds] mint_failed — paid seats without a booking, refund TODO',
              );
            }
            if (roundResult.companion && !roundResult.companion.ok) {
              request.log.warn(
                { orderId: roundResult.orderId, companion: roundResult.companion },
                '[wc handoff companion] upgrade_failed — paid companion without a booking, operator refund',
              );
            }
          }
        } catch (err) {
          request.log.error({ err }, '[wc handoff rounds] processor threw (non-fatal)');
        }
      }

      // Find the customer. Prefer normalized phone match (this is also the
      // login identifier); fall back to email. If neither resolves, the
      // webhook hasn't created the row yet AND no order payload was given —
      // return 409 so WP can either retry or fall back to its default
      // thank-you page.
      let customerId: string | undefined;
      if (parsed.data.phone) {
        try {
          const normalized = normalizeIsraeliPhone(parsed.data.phone);
          const rows = await db
            .select({ id: customers.id })
            .from(customers)
            .where(eq(customers.phone, normalized))
            .limit(1);
          customerId = rows[0]?.id;
        } catch {
          // Invalid Israeli phone format. Fall through to email match.
        }
      }
      if (!customerId && parsed.data.email) {
        const rows = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.email, parsed.data.email.toLowerCase()))
          .limit(1);
        customerId = rows[0]?.id;
      }
      if (!customerId) {
        request.log.info(
          { orderId: parsed.data.orderId, hasPhone: !!parsed.data.phone, hasEmail: !!parsed.data.email },
          '[wc handoff mint] customer_not_ready',
        );
        // Surface the processor diagnostic (zod issues / failure reason)
        // back to the WP caller so it lands in the WP error_log. This
        // endpoint is server-to-server and authed via the shared secret,
        // so exposing the diagnostic isn't a leak.
        return reply.code(409).send({
          error: 'customer_not_ready',
          ...(processorDiag !== undefined && { processor: processorDiag }),
        });
      }

      const minted = await mintHandoffToken(db, {
        customerId,
        source: 'wc_checkout',
        orderRef: parsed.data.orderId,
      });
      request.log.info(
        {
          customerId,
          orderId: parsed.data.orderId,
          tokenHashPrefix: tokenHashPrefix(minted.raw),
        },
        '[wc handoff mint] token_minted',
      );
      return { token: minted.raw, expiresAt: minted.expiresAt.toISOString() };
    },
  );

  fastify.post(
    '/auth/customer/wc-handoff/verify',
    {
      // Verify is the abusable surface (no auth header) — keep it tight.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      const result = await consumeHandoffToken(db, parsed.data.token);
      if (!result.ok) {
        request.log.info(
          { reason: result.reason, tokenHashPrefix: tokenHashPrefix(parsed.data.token) },
          '[wc handoff verify] rejected',
        );
        return reply.code(401).send({ error: 'invalid_or_consumed_token' });
      }

      // Token consumed; look up the customer profile to set the session.
      const rows = await db
        .select({
          id: customers.id,
          customerNumber: customers.customerNumber,
          firstName: customers.firstName,
          lastName: customers.lastName,
          phone: customers.phone,
          email: customers.email,
          preferredChannel: customers.preferredChannel,
          children: customers.children,
        })
        .from(customers)
        .where(eq(customers.id, result.customerId))
        .limit(1);
      const customer = rows[0];
      if (!customer) {
        // Token consumed but customer is gone (cascade from a delete that
        // raced with the verify). Surface as the same 401 so we don't leak
        // a different error code.
        request.log.warn(
          { customerId: result.customerId },
          '[wc handoff verify] customer disappeared after consume',
        );
        return reply.code(401).send({ error: 'invalid_or_consumed_token' });
      }

      const sessionToken = await signCustomerToken(customer.id, customerAuthConfig);
      setCustomerCookie(reply, sessionToken);

      // Render the editable thank-you copy from card_settings so the
      // /checkout-complete page shows operator-tweakable text without an
      // extra round-trip. {{firstName}} is the only supported placeholder
      // today; renderer falls back to "לקוח/ה" when missing.
      const settings = await getCardSettings(db);
      const thankyou = {
        title: renderHandoffThankyou(settings.checkoutThankyouTitle, {
          firstName: customer.firstName,
        }),
        body: renderHandoffThankyou(settings.checkoutThankyouBody, {
          firstName: customer.firstName,
        }),
        buttonText: settings.checkoutThankyouButtonText,
      };

      request.log.info(
        {
          customerId: customer.id,
          customerNumber: customer.customerNumber,
          source: result.source,
          tokenHashPrefix: tokenHashPrefix(parsed.data.token),
        },
        '[wc handoff verify] token_consumed',
      );
      return { ok: true, profile: customer, thankyou };
    },
  );
};
