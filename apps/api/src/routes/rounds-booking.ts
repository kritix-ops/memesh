import { db, roundAvailabilityForDate } from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';

// Customer-facing rounds flow. Availability is PUBLIC — the WordPress round
// picker reads it before the customer logs in — and rate-limited so it can't be
// scraped or used to exhaust the DB. Later PRs add hold / mint / swap / cancel
// here, gated by the customer session.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const roundsBookingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/rounds/availability',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const date = (request.query as { date?: string }).date;
      if (!date || !DATE_RE.test(date)) {
        return reply.code(400).send({ error: 'invalid_date' });
      }
      const rows = await roundAvailabilityForDate(db, date);
      request.log.info({ date, rounds: rows.length }, '[rounds availability]');
      // Public shape: enough to render the picker, nothing internal (no
      // per-round revenue, no held/booking internals).
      return {
        date,
        rounds: rows.map((r) => ({
          roundInstanceId: r.roundInstanceId,
          label: r.label,
          startTime: r.startTime,
          endTime: r.endTime,
          capacity: r.capacity,
          available: r.available,
          isClosed: r.isClosed,
        })),
      };
    },
  );
};
