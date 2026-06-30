import {
  db,
  giftPendingClaims,
  sweepExpiredGiftClaims,
} from '@memesh/db';
import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';

// Vercel Cron hits this route daily (configured in apps/web/vercel.json
// alongside the WC reconciliation cron). Stamps `expired_at` on
// `gift_pending_claims` rows whose `expires_at` has passed without being
// claimed, then fires a buyer-side "your gift wasn't claimed" email per
// row. With the 365-day default TTL these will be rare; the cron is cheap.
//
// Same Bearer-token auth model as cron-wc-reconcile so a third-party that
// stumbles onto the URL cannot trigger expiration sweeps.
export const cronGiftExpireRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/cron/gift-claims-expire', async (request, reply) => {
    const log = request.log;

    if (!env.CRON_SECRET) {
      log.error('[cron gift-expire] missing CRON_SECRET — refusing to run');
      return reply.code(503).send({ error: 'cron_secret_not_configured' });
    }
    const auth = request.headers.authorization;
    if (typeof auth !== 'string') {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const expected = `Bearer ${env.CRON_SECRET}`;
    let ok = false;
    try {
      const a = Buffer.from(auth, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length === b.length) ok = timingSafeEqual(a, b);
    } catch {
      ok = false;
    }
    if (!ok) {
      log.warn({ ip: request.ip }, '[cron gift-expire] auth mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    log.info('[cron gift-expire] start');
    const t0 = Date.now();
    try {
      const result = await sweepExpiredGiftClaims(db);
      const durationMs = Date.now() - t0;
      log.info(
        { expiredCount: result.expiredIds.length, durationMs },
        '[cron gift-expire] done',
      );

      // Log each expired row so an operator can hand-notify the buyer when
      // useful. v1 does not send the "your gift wasn't claimed" email
      // because that copy needs its own card_settings entries + template
      // builder; ops sees these log lines until the v2 work lands.
      // Per-row failures are swallowed so one bad row doesn't sabotage the
      // whole sweep.
      for (const id of result.expiredIds) {
        try {
          const rows = await db
            .select()
            .from(giftPendingClaims)
            .where(eq(giftPendingClaims.id, id))
            .limit(1);
          const row = rows[0];
          if (!row) continue;
          log.info(
            {
              pendingClaimId: row.id,
              wcOrderId: row.wcOrderId,
              buyerEmail: row.buyerEmail,
              recipientFirstName: row.recipientFirstName,
            },
            '[cron gift-expire] expired_swept — buyer hand-notify TODO v2',
          );
        } catch (err) {
          log.warn({ err, pendingClaimId: id }, '[cron gift-expire] per_row_error');
        }
      }

      return reply.send({
        ok: true,
        expired: result.expiredIds.length,
        durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - t0;
      log.error({ err, durationMs }, '[cron gift-expire] sweep_failed');
      return reply.code(500).send({ error: 'sweep_failed' });
    }
  });
};
