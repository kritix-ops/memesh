import { db } from '@memesh/db';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';
import {
  fireGiftBuyerEmail,
  fireGiftRecipientClaimEmail,
  fireGiftRecipientMagicEmail,
} from '../lib/gift-email.js';
import {
  processWcOrderWebhook,
  type ProcessWcOrderWebhookResult,
} from '../lib/wc-order-processor.js';
import { processRoundOrderWebhook } from '../lib/wc-round-processor.js';
import { firePostPurchaseEmail } from '../lib/post-purchase-email.js';
import { fireWcPostPurchaseSms } from '../lib/wc-post-purchase-sms.js';
import { envKeyResolver } from '../qr.js';

// WC ships the webhook over `application/json`. We need byte-exact access to
// the request body to compute the HMAC, which the default JSON parser
// destroys. This plugin registers a scoped content-type parser that keeps
// the raw Buffer on `request.rawBody` and exposes the parsed JSON to the
// route handler the normal way. Because the parser is added inside a
// Fastify plugin (no `fastify-plugin` wrapping), its scope ends at this
// plugin and does not change body parsing for the rest of the API.
//
// A wildcard fallback is also registered because some WP hosts / security
// plugins strip the Content-Type header from WC's ping delivery, and Fastify
// would otherwise 415 the request before HMAC verification could run. The
// fallback keeps the same rawBody + JSON.parse behavior; security is
// unchanged because the HMAC check still gates every request downstream.
export const webhooksWcRoutes: FastifyPluginAsync = async (fastify) => {
  const parseWebhookBody = (
    request: unknown,
    body: string | Buffer,
    done: (err: Error | null, body?: unknown) => void,
  ): void => {
    const buf = body as Buffer;
    // Save the byte-exact body for HMAC verification later in the route.
    (request as { rawBody: Buffer }).rawBody = buf;
    if (buf.length === 0) {
      // WC sometimes pings with an empty body when the webhook is first
      // activated. Hand back an empty object so the route can early-out
      // on topic/payload validation rather than 500-ing on a parse error.
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch {
      // Non-JSON body (or a body arriving without a Content-Type from a
      // stripping host): still expose rawBody so HMAC verification runs.
      // The route rejects downstream if the signature does not match.
      done(null, {});
    }
  };

  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, parseWebhookBody);
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, parseWebhookBody);

  // Optional smoke endpoint for end-to-end network checks (no auth, no
  // secrets exposed). Useful to confirm DNS + Vercel routing before
  // configuring the real webhook URL in WC admin.
  fastify.get('/webhooks/woocommerce/health', async () => ({ ok: true }));

  fastify.post('/webhooks/woocommerce/order', async (request, reply) => {
    const log = request.log;

    const signature = request.headers['x-wc-webhook-signature'];
    const topic = request.headers['x-wc-webhook-topic'];
    const deliveryId = request.headers['x-wc-webhook-delivery-id'];

    // WC's activation ping: clicking Save in WC admin POSTs `webhook_id=NN`
    // (form-encoded) with NO signature/topic/delivery headers — WooCommerce
    // never signs pings, only real deliveries. Acknowledge it with 200 so WC
    // marks the webhook active; anything else and the admin shows a delivery
    // error and eventually disables the webhook. Nothing is processed here,
    // so skipping the HMAC gate for this exact shape exposes nothing.
    const pingBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    if (
      typeof signature !== 'string' &&
      pingBody !== undefined &&
      /^webhook_id=\d+$/.test(pingBody.toString('utf8'))
    ) {
      log.info({ ping: pingBody.toString('utf8') }, '[webhook wc] activation ping acknowledged');
      return { ok: true, ping: true };
    }

    // Production guard: if no secret is configured, the route refuses to
    // process anything (would let unsigned traffic through). 503 so WC
    // retries instead of marking the webhook permanently disabled.
    if (!env.WC_WEBHOOK_SECRET) {
      log.error('[webhook wc] missing WC_WEBHOOK_SECRET — refusing to process');
      return reply.code(503).send({ error: 'webhook_secret_not_configured' });
    }

    if (
      typeof signature !== 'string' ||
      typeof topic !== 'string' ||
      typeof deliveryId !== 'string'
    ) {
      log.warn(
        { hasSig: typeof signature === 'string', hasTopic: typeof topic === 'string', hasDelivery: typeof deliveryId === 'string' },
        '[webhook wc] missing required headers',
      );
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      log.error('[webhook wc] rawBody missing — content-type parser misconfigured');
      return reply.code(500).send({ error: 'raw_body_missing' });
    }

    // HMAC-SHA256 of the raw body, base64-encoded.
    const expected = createHmac('sha256', env.WC_WEBHOOK_SECRET).update(rawBody).digest('base64');
    let signatureValid = false;
    try {
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(signature, 'utf8');
      if (a.length === b.length) signatureValid = timingSafeEqual(a, b);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      log.warn({ deliveryId, ip: request.ip }, '[webhook wc] signature_invalid');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    log.info({ deliveryId, topic }, '[webhook wc] received');

    let result: ProcessWcOrderWebhookResult;
    try {
      result = await processWcOrderWebhook(db, {
        deliveryId,
        topic,
        payload: request.body,
        resolver: envKeyResolver,
      });
    } catch (err) {
      log.error({ deliveryId, err }, '[webhook wc] exception');
      // 500 so WC retries the delivery.
      return reply.code(500).send({ error: 'processing_failed' });
    }

    // Round side: mint any round bookings on this order, independent of cards.
    // Skipped on a duplicate delivery (already handled). mintBooking is
    // idempotent per hold id, so this is safe even if it re-runs. A round-mint
    // exception is logged, not fatal — the card result already stands and WC
    // reconciliation/retry covers it. Failures (a seat taken while paying) mean
    // a paid seat with no booking → refund; that workflow lands with the cancel
    // PR, logged for an operator until then.
    if (result.status !== 'duplicate') {
      try {
        const roundResult = await processRoundOrderWebhook(db, {
          topic,
          payload: request.body,
          resolver: envKeyResolver,
        });
        if (roundResult.status === 'processed') {
          log.info(
            {
              deliveryId,
              orderId: roundResult.orderId,
              minted: roundResult.minted.length,
              failed: roundResult.failed.length,
              alreadyCancelled: roundResult.alreadyCancelled.length,
              companion: roundResult.companion,
            },
            '[webhook wc rounds] processed',
          );
          if (roundResult.failed.length > 0) {
            log.warn(
              { deliveryId, orderId: roundResult.orderId, failed: roundResult.failed },
              '[webhook wc rounds] mint_failed — paid seats without a booking, refund TODO',
            );
          }
          if (roundResult.companion && !roundResult.companion.ok) {
            log.warn(
              { deliveryId, orderId: roundResult.orderId, companion: roundResult.companion },
              '[webhook wc companion] upgrade_failed — paid companion without a booking, operator refund',
            );
          }
          // TODO (booking-notify PR): fire the barcode email/SMS for
          // roundResult.minted here.
        }
      } catch (err) {
        log.error({ deliveryId, err }, '[webhook wc rounds] exception');
      }
    }

    // Map result → log + 200 response. WC only cares that we returned 2xx.
    // The shape we return is for debugging / WC's delivery log preview only.
    switch (result.status) {
      case 'processed':
        log.info(
          {
            deliveryId,
            orderId: result.orderId,
            customerCreated: result.customerCreated,
            cardsCreated: result.cardsCreated.length,
            serials: result.cardsCreated,
          },
          '[webhook wc] done',
        );
        // Fire-and-log the post-purchase SMS magic link only when THIS
        // delivery actually created cards. A duplicate webhook (different
        // delivery id, same order, cards already minted by reconciliation
        // or the inline /wc-handoff/mint path) returns 'processed' with
        // cardsCreated: [] — we deliberately skip SMS there so the customer
        // gets exactly one SMS per real purchase. See
        // _plans/2026-06-22-wc-post-purchase-sms.md.
        if (result.cardsCreated.length > 0) {
          // Two channels fire in parallel; each mints its OWN handoff
          // token so the customer can tap either link without seeing an
          // "already used" error on the second tap. See the channel +
          // token decisions in _plans/2026-06-23-post-purchase-email.md.
          void fireWcPostPurchaseSms(db, {
            customerId: result.customerId,
            customerPhone: result.customerPhone,
            orderId: result.orderId,
            cards: result.cardsSummary,
            log,
          });
          void firePostPurchaseEmail(db, {
            customerId: result.customerId,
            customerEmail: result.customerEmail,
            customerFirstName: result.customerFirstName,
            source: 'wc_checkout',
            orderRef: result.orderId,
            cards: result.cardsSummary,
            log,
          });
        }
        return reply.send({
          ok: true,
          orderId: result.orderId,
          cardsCreated: result.cardsCreated.length,
        });
      case 'duplicate':
        log.info({ deliveryId }, '[webhook wc] duplicate');
        return reply.send({ ok: true, duplicate: true });
      case 'ignored_topic':
        log.info({ deliveryId, topic: result.topic }, '[webhook wc] ignored_topic');
        return reply.send({ ok: true, ignored: 'topic' });
      case 'ignored_status':
        log.info(
          { deliveryId, orderStatus: result.orderStatus },
          '[webhook wc] ignored_non_completed',
        );
        return reply.send({ ok: true, ignored: 'status' });
      case 'no_matching_skus':
        log.warn(
          { deliveryId, orderId: result.orderId },
          '[webhook wc] no_matching_skus — order has no configured כרטיסייה SKU',
        );
        return reply.send({ ok: true, ignored: 'no_matching_skus' });
      case 'invalid_payload':
        log.warn(
          { deliveryId, issues: result.issues },
          '[webhook wc] invalid_payload — failure recorded for admin review',
        );
        return reply.send({ ok: true, ignored: 'invalid_payload' });
      case 'failure':
        log.warn(
          { deliveryId, orderId: result.orderId, reason: result.reason },
          '[webhook wc] failure_recorded',
        );
        return reply.send({ ok: true, failure: result.reason });
      case 'processed_gift_direct':
        // Direct-mint gift order: recipient was already a Memesh customer,
        // card was added to their account. Fire the recipient magic-link
        // email + the buyer confirmation. Both are fire-and-log helpers
        // that never throw, so the webhook 200 response is not blocked on
        // Pulseem availability.
        log.info(
          {
            deliveryId,
            orderId: result.orderId,
            recipientCustomerId: result.recipientCustomerId,
            cardsCreated: result.cardsCreated.length,
            matchedBy: result.matchedBy,
            ...(result.recipientMatchConflictCustomerId && {
              conflictWithEmailMatchCustomerId: result.recipientMatchConflictCustomerId,
            }),
          },
          '[webhook wc gift] mint_immediate',
        );
        if (result.recipientMatchConflictCustomerId) {
          log.warn(
            {
              deliveryId,
              orderId: result.orderId,
              phoneCustomerId: result.recipientCustomerId,
              emailCustomerId: result.recipientMatchConflictCustomerId,
            },
            '[webhook wc gift] match_conflict — phone wins, admin review',
          );
        }
        // Only fire emails on the delivery that actually created cards.
        // A re-delivery whose cards were already minted (cardsCreated: [])
        // must not send a second pair of emails.
        if (result.cardsCreated.length > 0 && result.recipientCustomerEmail) {
          void fireGiftRecipientMagicEmail(db, {
            recipientCustomerId: result.recipientCustomerId,
            recipientEmail: result.recipientCustomerEmail,
            recipientFirstName: result.recipientFirstName,
            buyerFirstName: result.buyerFirstName,
            orderId: result.orderId,
            log,
          });
          void fireGiftBuyerEmail(db, {
            buyerEmail: result.buyerEmail,
            buyerFirstName: result.buyerFirstName,
            recipientFirstName: result.recipientFirstName,
            orderId: result.orderId,
            log,
          });
        }
        return reply.send({
          ok: true,
          orderId: result.orderId,
          gift: 'direct',
          cardsCreated: result.cardsCreated.length,
        });
      case 'processed_gift_pending':
        // Pending-claim gift order: recipient is brand new to Memesh. A
        // gift_pending_claims row holds the gift until the recipient
        // verifies their phone via the claim flow. Fire emails only on the
        // delivery that minted the pending row — re-deliveries have
        // alreadyExisted=true and no rawClaimToken, so the first delivery
        // already sent both emails.
        log.info(
          {
            deliveryId,
            orderId: result.orderId,
            pendingClaimId: result.pendingClaimId,
            alreadyExisted: result.alreadyExisted,
          },
          '[webhook wc gift] pending_created',
        );
        if (!result.alreadyExisted && result.rawClaimToken) {
          void fireGiftRecipientClaimEmail(db, {
            recipientEmail: result.recipientEmail,
            recipientFirstName: result.recipientFirstName,
            buyerFirstName: result.buyerFirstName,
            rawClaimToken: result.rawClaimToken,
            orderId: result.orderId,
            log,
          });
          void fireGiftBuyerEmail(db, {
            buyerEmail: result.buyerEmail,
            buyerFirstName: result.buyerFirstName,
            recipientFirstName: result.recipientFirstName,
            orderId: result.orderId,
            log,
          });
        }
        return reply.send({
          ok: true,
          orderId: result.orderId,
          gift: 'pending',
          alreadyExisted: result.alreadyExisted,
        });
    }
  });
};
