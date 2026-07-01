import {
  db,
  getRoundSettings,
  updateRoundSettings,
  type RoundSettingsValidationError,
  type UpdateRoundSettingsInput,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';

// Admin surface for the rounds operational settings singleton (super-brief §15):
// hold TTL, cancellation + claim windows, waitlist active hours, and the
// stay-duration reminder knobs. Range/format validation lives in the DB helper;
// this route just shapes the request and maps the error.

const updateBodySchema = z.object({
  roundsEnabled: z.boolean().optional(),
  holdTtlMinutes: z.number().int().optional(),
  cancellationWindowHours: z.number().int().optional(),
  claimWindowMinutes: z.number().int().optional(),
  activeHoursStart: z.number().int().optional(),
  activeHoursEnd: z.number().int().optional(),
  reminderOffsets: z.array(z.number().int()).optional(),
  closingTime: z.string().optional(),
  skipLastRoundReminder: z.boolean().optional(),
}).strict();

const validationStatus: Record<RoundSettingsValidationError['code'], number> = {
  hold_ttl_out_of_range: 400,
  cancellation_window_out_of_range: 400,
  claim_window_out_of_range: 400,
  active_hours_out_of_range: 400,
  reminder_offsets_invalid: 400,
  closing_time_invalid: 400,
};

export const roundSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/admin/round-settings', { preHandler: requireRoleHook('admin') }, async () => {
    const settings = await getRoundSettings(db);
    return { settings };
  });

  fastify.patch(
    '/admin/round-settings',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const parsed = updateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const d = parsed.data;
      const patch: UpdateRoundSettingsInput = {
        ...(d.roundsEnabled !== undefined && { roundsEnabled: d.roundsEnabled }),
        ...(d.holdTtlMinutes !== undefined && { holdTtlMinutes: d.holdTtlMinutes }),
        ...(d.cancellationWindowHours !== undefined && {
          cancellationWindowHours: d.cancellationWindowHours,
        }),
        ...(d.claimWindowMinutes !== undefined && { claimWindowMinutes: d.claimWindowMinutes }),
        ...(d.activeHoursStart !== undefined && { activeHoursStart: d.activeHoursStart }),
        ...(d.activeHoursEnd !== undefined && { activeHoursEnd: d.activeHoursEnd }),
        ...(d.reminderOffsets !== undefined && { reminderOffsets: d.reminderOffsets }),
        ...(d.closingTime !== undefined && { closingTime: d.closingTime }),
        ...(d.skipLastRoundReminder !== undefined && {
          skipLastRoundReminder: d.skipLastRoundReminder,
        }),
      };
      const result = await updateRoundSettings(db, patch);
      if (!result.ok) {
        return reply.code(validationStatus[result.error.code]).send({ error: result.error.code });
      }
      request.log.info({ diff: result.diff }, '[admin round-settings] updated');
      return { settings: result.row, diff: result.diff };
    },
  );
};
