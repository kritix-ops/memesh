import { db } from '@memesh/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';
import { reconcileWcOrders } from '../lib/wc-reconciliation.js';
import { createWcRestClient } from '../lib/wc-rest-client.js';
import { envKeyResolver } from '../qr.js';

// Vercel Cron hits this route hourly via the `crons` config in
// apps/web/vercel.json. Vercel automatically attaches
// `Authorization: Bearer ${CRON_SECRET}` to every cron invocation when the
// project has CRON_SECRET set, so no other auth gates apply.
//
// Method is GET (Vercel Cron uses GET) — the cron does no writes other than
// what the reconciliation pipeline performs in the DB.
export const cronWcReconcileRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/cron/wc-reconcile', async (request, reply) => {
    const log = request.log;

    if (!env.CRON_SECRET) {
      log.error('[cron wc-reconcile] missing CRON_SECRET — refusing to run');
      return reply.code(503).send({ error: 'cron_secret_not_configured' });
    }

    const auth = request.headers.authorization;
    if (typeof auth !== 'string') {
      log.warn({ ip: request.ip }, '[cron wc-reconcile] missing Authorization header');
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
      log.warn({ ip: request.ip }, '[cron wc-reconcile] auth mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    if (!env.WC_API_URL || !env.WC_API_CONSUMER_KEY || !env.WC_API_CONSUMER_SECRET) {
      log.error('[cron wc-reconcile] missing WC API credentials');
      return reply.code(503).send({ error: 'wc_api_not_configured' });
    }

    const wcClient = createWcRestClient({
      baseUrl: env.WC_API_URL,
      consumerKey: env.WC_API_CONSUMER_KEY,
      consumerSecret: env.WC_API_CONSUMER_SECRET,
    });

    log.info(
      { lookbackHours: env.WC_RECONCILE_LOOKBACK_HOURS },
      '[cron wc-reconcile] start',
    );

    const t0 = Date.now();
    try {
      const result = await reconcileWcOrders(
        db,
        { wcClient, resolver: envKeyResolver },
        { lookbackHours: env.WC_RECONCILE_LOOKBACK_HOURS },
      );
      const durationMs = Date.now() - t0;
      log.info({ ...result, durationMs }, '[cron wc-reconcile] done');
      return reply.send({ ok: true, ...result, durationMs });
    } catch (err) {
      const durationMs = Date.now() - t0;
      log.error({ err, durationMs }, '[cron wc-reconcile] api_error');
      // 500 so Vercel records the failure; next hourly run starts fresh.
      return reply.code(500).send({ error: 'reconciliation_failed' });
    }
  });
};
