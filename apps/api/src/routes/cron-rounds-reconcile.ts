import { db } from '@memesh/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';
import { healChargedUnpaidOrders, type HealableStatus } from '../lib/wc-paid-cancel-heal.js';
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
//
// It also runs the charged-but-unpaid heal first (wc-paid-cancel-heal.ts):
// orders PayPlus charged but the plugin never marked paid — stuck in `pending`
// or already auto-cancelled by WC's unpaid time limit — are flipped to
// `processing`, then minted by the reconcile pass on the same tick.
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

    // Paginates one WC order status until drained or the safety cap. Shared by
    // the paid fetch (reconcile) and the pending/cancelled fetch (heal).
    const listStatusSince = async (status: string, since: Date): Promise<unknown[]> => {
      const sinceIso = since.toISOString();
      const all: unknown[] = [];
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
      return all;
    };

    // Paid round orders sit in `processing` (paid, not yet operator-completed),
    // so — unlike the card reconciliation's completed-only fetch — we pull both
    // statuses or we'd never see the tickets we're here to heal.
    const listPaidOrdersSince = async (since: Date): Promise<unknown[]> => {
      const all: unknown[] = [];
      for (const status of ['processing', 'completed'] as const) {
        all.push(...(await listStatusSince(status, since)));
      }
      return all;
    };

    const listOrdersByStatusSince = (status: HealableStatus, since: Date) =>
      listStatusSince(status, since);

    // Flip a charged-but-unpaid order to paid. `set_paid` makes WC stamp
    // date_paid, send the customer the normal processing email, and fire its
    // `order.updated` webhook — the same paid flow a healthy callback triggers.
    const markOrderPaid = async (orderId: number, transactionUid: string): Promise<void> => {
      const res = await fetch(`${baseUrl}/orders/${orderId}`, {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'processing',
          set_paid: true,
          transaction_id: transactionUid,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[wc-rest] heal set-paid failed: ${res.status} ${text.slice(0, 200)}`);
      }
      // Trust but verify: a 2xx that did not actually transition the order
      // would silently re-strand the customer, so require the paid status.
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      if (!body || (body.status !== 'processing' && body.status !== 'completed')) {
        throw new Error(
          `[wc-rest] heal set-paid returned status ${body?.status ?? 'unknown'} for order ${orderId}`,
        );
      }
    };

    log.info(
      { lookbackHours: env.WC_RECONCILE_LOOKBACK_HOURS },
      '[cron rounds-reconcile] start',
    );

    const t0 = Date.now();
    try {
      // Heal first: a PayPlus-charged order stuck in pending/cancelled (plugin
      // callback saved its meta but never completed payment — order 6051,
      // 2026-08-07) is flipped to processing here, so the reconcile pass below
      // sees it in the paid set and mints it on this same tick.
      const heal = await healChargedUnpaidOrders(
        { listOrdersByStatusSince, markOrderPaid },
        { lookbackHours: env.WC_RECONCILE_LOOKBACK_HOURS },
      );
      // Money rescued (or a rescue that failed) is operator-relevant — surface
      // loudly. Order ids + amounts only; no customer PII in logs.
      if (heal.healed.length > 0) {
        log.warn(
          { healed: heal.healed },
          '[cron rounds-reconcile] healed_charged_orders — charged orders were stuck unpaid',
        );
      }
      if (heal.failed.length > 0) {
        log.error(
          { failed: heal.failed },
          '[cron rounds-reconcile] heal_failed — charged order could not be set paid, will retry',
        );
      }

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
      log.info(
        {
          ...result,
          healScanned: heal.ordersScanned,
          healHealed: heal.healed.length,
          healSkippedPendingGrace: heal.skippedPendingGrace,
          healFailed: heal.failed.length,
          durationMs,
        },
        '[cron rounds-reconcile] done',
      );
      return reply.send({ ok: true, ...result, heal, durationMs });
    } catch (err) {
      const durationMs = Date.now() - t0;
      log.error({ err, durationMs }, '[cron rounds-reconcile] api_error');
      // 500 so Vercel records the failure; next minute's run starts fresh.
      return reply.code(500).send({ error: 'reconciliation_failed' });
    }
  });
};
