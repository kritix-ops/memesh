import { db } from '@memesh/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';
import { reconcileRoundBookings } from '../lib/wc-round-reconciliation.js';
import { envKeyResolver } from '../qr.js';

// Vercel Cron hits this route every minute via the `crons` config in
// apps/api-deploy/vercel.json. Vercel automatically attaches
// `Authorization: Bearer ${CRON_SECRET}` to every cron invocation when the
// project has CRON_SECRET set, so no other auth gates apply.
//
// Method is GET (Vercel Cron uses GET) — the cron does no writes other than
// what the reconciliation pipeline performs in the DB.
//
// This is the ROUND-BOOKING safety net (mirrors /cron/wc-reconcile, which
// heals cards): it re-mints any paid WC round order the live webhook missed,
// so a blanked/mismatched webhook secret can never again leave paid customers
// invisible to staff for more than ~a minute. See wc-round-reconciliation.ts.
export const cronRoundsReconcileRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/cron/rounds-reconcile', async (request, reply) => {
    const log = request.log;

    if (!env.CRON_SECRET) {
      log.error('[cron rounds-reconcile] missing CRON_SECRET — refusing to run');
      return reply.code(503).send({ error: 'cron_secret_not_configured' });
    }

    const auth = request.headers.authorization;
    if (typeof auth !== 'string') {
      log.warn({ ip: request.ip }, '[cron rounds-reconcile] missing Authorization header');
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
      log.warn({ ip: request.ip }, '[cron rounds-reconcile] auth mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    if (!env.WC_API_URL || !env.WC_API_CONSUMER_KEY || !env.WC_API_CONSUMER_SECRET) {
      log.error('[cron rounds-reconcile] missing WC API credentials');
      return reply.code(503).send({ error: 'wc_api_not_configured' });
    }

    const baseUrl = env.WC_API_URL.replace(/\/$/, '');
    const authHeader = `Basic ${Buffer.from(
      `${env.WC_API_CONSUMER_KEY}:${env.WC_API_CONSUMER_SECRET}`,
    ).toString('base64')}`;

    // Paid round orders sit in `processing` (paid, not yet operator-completed),
    // so — unlike the card reconciliation's completed-only fetch — we pull both
    // statuses or we'd never see the tickets we're here to heal. Paginates each
    // status until drained or the safety cap.
    const listPaidOrdersSince = async (since: Date): Promise<unknown[]> => {
      const sinceIso = since.toISOString();
      const all: unknown[] = [];
      for (const status of ['processing', 'completed'] as const) {
        for (let page = 1; page <= 50; page += 1) {
          const url = `${baseUrl}/orders?status=${status}&after=${encodeURIComponent(
            sinceIso,
          )}&per_page=100&page=${page}&orderby=date&order=asc`;
          const res = await fetch(url, {
            headers: { Authorization: authHeader, Accept: 'application/json' },
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(
              `[wc-rest] round-recon orders fetch failed: ${res.status} ${text.slice(0, 200)}`,
            );
          }
          const body = (await res.json()) as unknown[];
          if (!Array.isArray(body)) {
            throw new Error('[wc-rest] orders response was not an array');
          }
          all.push(...body);
          const totalPagesHeader = res.headers.get('x-wp-totalpages');
          const totalPages = totalPagesHeader ? Number.parseInt(totalPagesHeader, 10) : null;
          if (totalPages !== null && page >= totalPages) break;
          if (body.length < 100) break;
        }
      }
      return all;
    };

    log.info(
      { lookbackHours: env.WC_RECONCILE_LOOKBACK_HOURS },
      '[cron rounds-reconcile] start',
    );

    const t0 = Date.now();
    try {
      const result = await reconcileRoundBookings(
        db,
        { listPaidOrdersSince, resolver: envKeyResolver },
        { lookbackHours: env.WC_RECONCILE_LOOKBACK_HOURS },
      );
      const durationMs = Date.now() - t0;
      // Orphaned paid seats are the real alarm — a paid ticket we could not
      // seat (bad hold id / round sold out after payment). Surface loudly.
      if (result.orphanedPaidSeats > 0) {
        log.warn(
          { ...result, durationMs },
          '[cron rounds-reconcile] orphaned_paid_seats — operator review',
        );
      }
      log.info({ ...result, durationMs }, '[cron rounds-reconcile] done');
      return reply.send({ ok: true, ...result, durationMs });
    } catch (err) {
      const durationMs = Date.now() - t0;
      log.error({ err, durationMs }, '[cron rounds-reconcile] api_error');
      // 500 so Vercel records the failure; next minute's run starts fresh.
      return reply.code(500).send({ error: 'reconciliation_failed' });
    }
  });
};
