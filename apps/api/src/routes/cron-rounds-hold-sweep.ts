import { db, expireHolds } from '@memesh/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';

// Vercel Cron hits this to flip expired holds (held → expired) past their TTL
// (super-brief §3.3). Lazy expiry already keeps availability correct, so this is
// for DB hygiene and — once the waitlist lands — prompt promotion of the freed
// seats. Same Bearer-CRON_SECRET auth as the other cron routes so a stray hit
// on the URL can't trigger sweeps.
export const cronRoundsHoldSweepRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/cron/rounds-hold-sweep', async (request, reply) => {
    const log = request.log;

    if (!env.CRON_SECRET) {
      log.error('[cron hold-sweep] missing CRON_SECRET — refusing to run');
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
      log.warn({ ip: request.ip }, '[cron hold-sweep] auth mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const t0 = Date.now();
    try {
      const freed = await expireHolds(db);
      // Waitlist promotion for `freed` lands in the waitlist PR; for now the
      // sweep is pure hygiene (lazy expiry already keeps availability correct).
      log.info({ expired: freed.length, durationMs: Date.now() - t0 }, '[cron hold-sweep] done');
      return reply.send({ ok: true, expired: freed.length });
    } catch (err) {
      log.error({ err, durationMs: Date.now() - t0 }, '[cron hold-sweep] sweep_failed');
      return reply.code(500).send({ error: 'sweep_failed' });
    }
  });
};
