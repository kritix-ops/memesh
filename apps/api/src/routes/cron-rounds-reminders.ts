import { claimDueReminders, db } from '@memesh/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config.js';
import { fireRoundReminder } from '../lib/round-reminder-notify.js';

// Vercel Cron hits this every minute to send stay-duration reminders
// (super-brief §9): claimDueReminders finds the (round, offset) reminders due
// right now and claims them idempotently, then each due batch is sent to its
// confirmed bookings. Same Bearer-CRON_SECRET auth as the other cron routes.
export const cronRoundsRemindersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/cron/rounds-reminders', async (request, reply) => {
    const log = request.log;

    if (!env.CRON_SECRET) {
      log.error('[cron reminders] missing CRON_SECRET — refusing to run');
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
      log.warn({ ip: request.ip }, '[cron reminders] auth mismatch');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const t0 = Date.now();
    try {
      const due = await claimDueReminders(db);
      let sms = 0;
      for (const reminder of due) {
        sms += await fireRoundReminder(reminder, log);
      }
      log.info({ batches: due.length, sms, durationMs: Date.now() - t0 }, '[cron reminders] done');
      return reply.send({ ok: true, batches: due.length, sms });
    } catch (err) {
      log.error({ err, durationMs: Date.now() - t0 }, '[cron reminders] reminders_failed');
      return reply.code(500).send({ error: 'reminders_failed' });
    }
  });
};
