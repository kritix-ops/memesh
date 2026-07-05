import { db, ensureAllActiveInstances, INSTANCE_HORIZON_DAYS } from '@memesh/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';

// Vercel Cron hits this daily to keep round_instances materialized through
// the whole booking window (INSTANCE_HORIZON_DAYS, plan
// 2026-07-05-booking-window-365). Before the cron, the window only rolled
// forward when the admin happened to open the rounds page — with customers
// booking up to a year ahead, availability can't depend on that. Idempotent
// (onConflictDoNothing), so overlap with the on-view top-up is harmless. Same
// Bearer-CRON_SECRET auth as the other cron routes.
export const cronRoundsInstancesTopupRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/cron/rounds-instances-topup', async (request, reply) => {
    const log = request.log;

    if (!env.CRON_SECRET) {
      log.error('[cron instances-topup] missing CRON_SECRET — refusing to run');
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
      log.warn({ ip: request.ip }, '[cron instances-topup] auth mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const t0 = Date.now();
    try {
      const created = await ensureAllActiveInstances(db);
      log.info(
        { created, horizonDays: INSTANCE_HORIZON_DAYS, durationMs: Date.now() - t0 },
        '[cron instances-topup] done',
      );
      return reply.send({ ok: true, created });
    } catch (err) {
      log.error({ err, durationMs: Date.now() - t0 }, '[cron instances-topup] topup_failed');
      return reply.code(500).send({ error: 'topup_failed' });
    }
  });
};
