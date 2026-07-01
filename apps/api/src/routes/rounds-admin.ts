import {
  countUpcomingInstances,
  createRound,
  createScheduleRule,
  db,
  deleteRound,
  deleteScheduleRule,
  duplicateRound,
  ensureAllActiveInstances,
  listRounds,
  listScheduleRules,
  updateRound,
  type Round,
  type RoundInput,
  type RoundPatch,
  type ScheduleRuleInput,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';

// Admin-only management of round templates + their materialized instances.
// Business validation (times, capacity, day bitmask, string lengths) lives in
// the DB helper and surfaces as specific 400 codes; zod here only pins the
// request shape/types. See _plans/2026-07-01-admin-rounds-management.md.

const createSchema = z.object({
  label: z.string(),
  displayName: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  daysActive: z.number().int(),
  defaultCapacity: z.number().int(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const patchSchema = createSchema
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const scheduleRuleSchema = z.object({
  dateFrom: z.string().regex(DATE_RE).nullable().optional(),
  dateTo: z.string().regex(DATE_RE).nullable().optional(),
  weekdayMask: z.number().int().nullable().optional(),
  windows: z.array(z.object({ start: z.string(), end: z.string() })),
  outside: z.enum(['free_play', 'closed']),
  note: z.string().nullable().optional(),
});

// Serialize a stored round for the SPA: Postgres TIME 'HH:MM:SS' → 'HH:MM'.
function serializeRound(r: Round) {
  return {
    id: r.id,
    label: r.label,
    displayName: r.displayName,
    startTime: r.startTime.slice(0, 5),
    endTime: r.endTime.slice(0, 5),
    daysActive: r.daysActive,
    defaultCapacity: r.defaultCapacity,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
  };
}

export const roundsAdminRoutes: FastifyPluginAsync = async (fastify) => {
  // List templates. Tops up the rolling instance window first so newly-passed
  // days get replaced without a separate job (materialize-on-view, v1).
  fastify.get('/admin/rounds', { preHandler: requireRoleHook('admin') }, async (request) => {
    await ensureAllActiveInstances(db);
    const rows = await listRounds(db);
    const counts = await countUpcomingInstances(db);
    request.log.info({ rounds: rows.length }, '[rounds admin list]');
    return {
      rounds: rows.map((r) => ({ ...serializeRound(r), upcomingInstances: counts.get(r.id) ?? 0 })),
    };
  });

  // Create a template + materialize its upcoming instances.
  fastify.post('/admin/rounds', { preHandler: requireRoleHook('admin') }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    // Build the input explicitly so the optional keys aren't set to `undefined`
    // (exactOptionalPropertyTypes rejects that against RoundInput).
    const d = parsed.data;
    const input: RoundInput = {
      label: d.label,
      displayName: d.displayName,
      startTime: d.startTime,
      endTime: d.endTime,
      daysActive: d.daysActive,
      defaultCapacity: d.defaultCapacity,
      ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
      ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
    };
    const result = await createRound(db, input);
    if (!result.ok) {
      request.log.info({ error: result.error }, '[rounds admin create] rejected');
      return reply.code(400).send({ error: result.error.code });
    }
    request.log.info({ id: result.round.id }, '[rounds admin create]');
    return { round: serializeRound(result.round) };
  });

  // Edit a template. Re-materializes so a newly-added weekday or reactivation
  // starts appearing immediately.
  fastify.patch('/admin/rounds/:id', { preHandler: requireRoleHook('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    // Build the patch with only the provided keys — copying parsed.data whole
    // carries `| undefined` on every field, which exactOptionalPropertyTypes
    // rejects against RoundPatch.
    const p = parsed.data;
    const patch: RoundPatch = {};
    if (p.label !== undefined) patch.label = p.label;
    if (p.displayName !== undefined) patch.displayName = p.displayName;
    if (p.startTime !== undefined) patch.startTime = p.startTime;
    if (p.endTime !== undefined) patch.endTime = p.endTime;
    if (p.daysActive !== undefined) patch.daysActive = p.daysActive;
    if (p.defaultCapacity !== undefined) patch.defaultCapacity = p.defaultCapacity;
    if (p.isActive !== undefined) patch.isActive = p.isActive;
    if (p.sortOrder !== undefined) patch.sortOrder = p.sortOrder;

    const result = await updateRound(db, id, patch);
    if (!result.ok) {
      if ('notFound' in result) return reply.code(404).send({ error: 'not_found' });
      request.log.info({ error: result.error }, '[rounds admin update] rejected');
      return reply.code(400).send({ error: result.error.code });
    }
    request.log.info({ id: result.round.id }, '[rounds admin update]');
    return { round: serializeRound(result.round) };
  });

  // Schedule rules — when the rounds system applies (windows per date/range/
  // weekday, free-play vs closed outside them). Static segment, so no clash
  // with the :id routes below.
  fastify.get('/admin/rounds/schedule-rules', { preHandler: requireRoleHook('admin') }, async () => {
    const rules = await listScheduleRules(db);
    return { rules };
  });

  fastify.post(
    '/admin/rounds/schedule-rules',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const parsed = scheduleRuleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const d = parsed.data;
      const input: ScheduleRuleInput = {
        dateFrom: d.dateFrom ?? null,
        dateTo: d.dateTo ?? null,
        weekdayMask: d.weekdayMask ?? null,
        windows: d.windows,
        outside: d.outside,
        note: d.note ?? null,
      };
      const result = await createScheduleRule(db, input);
      if (!result.ok) {
        request.log.info({ error: result.error }, '[rounds schedule] create rejected');
        return reply.code(400).send({ error: result.error.code });
      }
      request.log.info(
        {
          ruleId: result.rule.id,
          dateFrom: result.rule.dateFrom,
          dateTo: result.rule.dateTo,
          weekdayMask: result.rule.weekdayMask,
          windows: result.rule.windows,
          outside: result.rule.outside,
        },
        '[rounds schedule] rule created',
      );
      return { rule: result.rule };
    },
  );

  fastify.delete(
    '/admin/rounds/schedule-rules/:id',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await deleteScheduleRule(db, id);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      request.log.info({ ruleId: id }, '[rounds schedule] rule deleted');
      return { ok: true };
    },
  );

  // Duplicate a template. The copy is created inactive ("(עותק)" suffix) so
  // the admin renames/reviews before it goes live.
  fastify.post(
    '/admin/rounds/:id/duplicate',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await duplicateRound(db, id);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      request.log.info({ sourceId: id, newId: result.round.id }, '[rounds admin duplicate]');
      return { round: serializeRound(result.round) };
    },
  );

  // Delete a template. Refused (409) once any booking ever touched it —
  // bookings are the audit trail; deactivate instead.
  fastify.delete(
    '/admin/rounds/:id',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await deleteRound(db, id);
      if (!result.ok) {
        const code = result.error === 'not_found' ? 404 : 409;
        request.log.info({ id, error: result.error }, '[rounds admin delete] rejected');
        return reply.code(code).send({ error: result.error });
      }
      request.log.info({ id }, '[rounds admin delete]');
      return { ok: true };
    },
  );
};
