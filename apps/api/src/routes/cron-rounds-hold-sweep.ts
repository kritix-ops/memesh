import { db, expireHolds, expireWaitlistClaims, promoteWaitlist } from '@memesh/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';
import { fireWaitlistOffer } from '../lib/waitlist-notify.js';

// Vercel Cron hits this to flip expired holds (held → expired) past their TTL
// (super-brief §3.3), then drive the waitlist (§8): every hold that expired
// freed a seat, so offer it to that round's waitlist; and any claim offer that
// lapsed gets expired and re-offered to the next in line. Lazy expiry already
// keeps availability correct, so the sweep is also DB hygiene. Same
// Bearer-CRON_SECRET auth as the other cron routes so a stray hit on the URL
// can't trigger sweeps.
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
      // Lapsed claim offers → expired; each returns a round to re-offer.
      const reoffer = await expireWaitlistClaims(db);
      // Every round that gained a free seat (a hold expired, or an offer lapsed)
      // gets its waitlist offered to. Dedupe so a round is promoted once.
      const roundsToPromote = [...new Set([...freed.map((f) => f.roundInstanceId), ...reoffer])];
      let promoted = 0;
      for (const roundInstanceId of roundsToPromote) {
        try {
          const res = await promoteWaitlist(db, roundInstanceId);
          if (res.promoted) {
            promoted += 1;
            await fireWaitlistOffer(res.promoted, log);
          }
        } catch (err) {
          log.error({ err, roundInstanceId }, '[cron hold-sweep] promote failed (non-fatal)');
        }
      }
      log.info(
        { expired: freed.length, reoffered: reoffer.length, promoted, durationMs: Date.now() - t0 },
        '[cron hold-sweep] done',
      );
      return reply.send({ ok: true, expired: freed.length, promoted });
    } catch (err) {
      log.error({ err, durationMs: Date.now() - t0 }, '[cron hold-sweep] sweep_failed');
      return reply.code(500).send({ error: 'sweep_failed' });
    }
  });
};
