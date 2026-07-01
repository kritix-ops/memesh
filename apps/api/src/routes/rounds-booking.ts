import { createHold, db, releaseHold, roundAvailabilityForDate } from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCustomer } from '../lib/customer-guard.js';

// Customer-facing rounds flow. Availability is PUBLIC — the WordPress round
// picker reads it before the customer logs in — and rate-limited so it can't be
// scraped or used to exhaust the DB. Hold + release are customer-gated (a
// booking is bound to its owner). Later PRs add mint / swap / cancel here.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const holdSchema = z.object({
  roundInstanceId: z.string().uuid(),
  ticketType: z.enum(['child_under_walking', 'child_over_walking']),
  additionalCompanions: z.number().int().min(0).max(1).optional(),
});

const releaseSchema = z.object({ holdId: z.string().uuid() });

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

  // Reserve one child seat before payment (super-brief §3). Customer-gated —
  // the held booking is bound to the session customer. Rate-limited so a
  // single account can't tie up capacity with a flood of holds.
  fastify.post(
    '/rounds/hold',
    { preHandler: requireCustomer, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const customerId = request.customer?.id;
      if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
      const parsed = holdSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const result = await createHold(db, {
        roundInstanceId: parsed.data.roundInstanceId,
        customerId,
        ticketType: parsed.data.ticketType,
        ...(parsed.data.additionalCompanions !== undefined
          ? { additionalCompanions: parsed.data.additionalCompanions }
          : {}),
      });
      if (!result.ok) {
        // not_found → 404; closed / sold_out → 409 (the request was valid, the
        // seat just isn't available).
        const code = result.error === 'not_found' ? 404 : 409;
        return reply.code(code).send({ error: result.error });
      }
      request.log.info({ holdId: result.holdId, customerId }, '[rounds hold] created');
      return { holdId: result.holdId, expiresAt: result.expiresAt };
    },
  );

  // Release a held seat early. Owner-gated in the DB helper; the route also
  // passes the session customer so one customer can't release another's hold.
  fastify.post('/rounds/hold/release', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = releaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await releaseHold(db, parsed.data.holdId, customerId);
    if (!result.ok) {
      const code = result.error === 'not_found' ? 404 : result.error === 'forbidden' ? 403 : 409;
      return reply.code(code).send({ error: result.error });
    }
    request.log.info({ holdId: parsed.data.holdId, customerId }, '[rounds hold] released');
    return { ok: true };
  });
};
