import {
  CARD_SETTINGS_LIMITS,
  db,
  getCardSettings,
  updateCardSettings,
  type CardSettingsValidationError,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';

const STAFF = ['cashier', 'manager', 'admin'] as const;

const updateBodySchema = z.object({
  priceShekels: z
    .number()
    .int()
    .min(CARD_SETTINGS_LIMITS.priceShekels.min)
    .max(CARD_SETTINGS_LIMITS.priceShekels.max)
    .optional(),
  validityDays: z
    .number()
    .int()
    .min(CARD_SETTINGS_LIMITS.validityDays.min)
    .max(CARD_SETTINGS_LIMITS.validityDays.max)
    .optional(),
  totalEntries: z
    .number()
    .int()
    .min(CARD_SETTINGS_LIMITS.totalEntries.min)
    .max(CARD_SETTINGS_LIMITS.totalEntries.max)
    .optional(),
  pitchLabel: z
    .string()
    .trim()
    .min(CARD_SETTINGS_LIMITS.pitchLabel.minLength)
    .max(CARD_SETTINGS_LIMITS.pitchLabel.maxLength)
    .optional(),
});

const validationStatus: Record<CardSettingsValidationError, number> = {
  price_out_of_range: 400,
  validity_out_of_range: 400,
  entries_out_of_range: 400,
  pitch_length: 400,
  no_changes: 409,
};

export const cardSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  // Read full settings — admin-only edit surface needs every field.
  fastify.get(
    '/admin/card-settings',
    { preHandler: requireRoleHook('admin') },
    async (request) => {
      const settings = await getCardSettings(db);
      request.log.info('[card-settings get]');
      return { settings };
    },
  );

  // Update settings. Admin-only. Returns the new row + the diff for the UI's
  // success toast and the audit log. PATCH because the body is a partial.
  fastify.patch(
    '/admin/card-settings',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const parsed = updateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const result = await updateCardSettings(db, {
        ...parsed.data,
        ...(request.user ? { staffId: request.user.id } : {}),
      });

      if (!result.ok) {
        request.log.info({ error: result.error }, '[card-settings update] rejected');
        return reply.code(validationStatus[result.error]).send({ error: result.error });
      }

      request.log.info(
        { diff: result.diff, staffId: request.user?.id },
        '[card-settings update]',
      );
      return { settings: result.row, diff: result.diff };
    },
  );

  // Public read for the POS sell screen. Returns only the customer-facing
  // fields (price + pitch). Validity and total entries are server-internal.
  fastify.get(
    '/pos/card-pricing',
    { preHandler: requireRoleHook(...STAFF) },
    async () => {
      const settings = await getCardSettings(db);
      return {
        priceShekels: settings.priceShekels,
        pitchLabel: settings.pitchLabel,
      };
    },
  );
};
