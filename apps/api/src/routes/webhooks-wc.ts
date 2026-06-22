import { db } from '@memesh/db';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';
import {
  processWcOrderWebhook,
  type ProcessWcOrderWebhookResult,
} from '../lib/wc-order-processor.js';
import { fireWcPostPurchaseSms } from '../lib/wc-post-purchase-sms.js';
import { envKeyResolver } from '../qr.js';

// WC ships the webhook over `application/json`. We need byte-exact access to
// the request body to compute the HMAC, which the default JSON parser
// destroys. This plugin registers a scoped content-type parser that keeps
// the raw Buffer on `request.rawBody` and exposes the parsed JSON to the
// route handler the normal way. Because the parser is added inside a
// Fastify plugin (no `fastify-plugin` wrapping), its scope ends at this
// plugin and does not change body parsing for the rest of the API.
export const webhooksWcRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      const buf = body as Buffer;
      // Save the byte-exact body for HMAC verification later in the route.
      (_request as unknown as { rawBody: Buffer }).rawBody = buf;
      if (buf.length === 0) {
        // WC sometimes pings with an empty body when the webhook is first
        // activated. Hand back an empty object so the route can early-out
        // on topic/payload validation rather than 500-ing on a parse error.
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(buf.toString('utf8')));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // Optional smoke endpoint for end-to-end network checks (no auth, no
  // secrets exposed). Useful to confirm DNS + Vercel routing before
  // configuring the real webhook URL in WC admin.
  fastify.get('/webhooks/woocommerce/health', async () => ({ ok: true }));

  fastify.post('/webhooks/woocommerce/order', async (request, reply) => {
    const log = request.log;

    // Production guard: if no secret is configured, the route refuses to
    // process anything (would let unsigned traffic through). 503 so WC
    // retries instead of marking the webhook permanently disabled.
    if (!env.WC_WEBHOOK_SECRET) {
      log.error('[webhook wc] missing WC_WEBHOOK_SECRET — refusing to process');
      return reply.code(503).send({ error: 'webhook_secret_not_configured' });
    }

    const signature = request.headers['x-wc-webhook-signature'];
    const topic = request.headers['x-wc-webhook-topic'];
    const deliveryId = request.headers['x-wc-webhook-delivery-id'];

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
          void fireWcPostPurchaseSms(db, {
            customerId: result.customerId,
            customerPhone: result.customerPhone,
            orderId: result.orderId,
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
    }
  });
};
