import {
  countUpcomingInstances,
  createRound,
  db,
  ensureAllActiveInstances,
  listRounds,
  updateRound,
  type Round,
  type RoundInput,
  type RoundPatch,
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
};
