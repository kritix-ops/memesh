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
const MANAGER_OR_ADMIN = ['manager', 'admin'] as const;

const L = CARD_SETTINGS_LIMITS;

const updateBodySchema = z.object({
  // Pricing + lifetime
  priceShekels: z.number().int().min(L.priceShekels.min).max(L.priceShekels.max).optional(),
  validityDays: z.number().int().min(L.validityDays.min).max(L.validityDays.max).optional(),
  totalEntries: z.number().int().min(L.totalEntries.min).max(L.totalEntries.max).optional(),
  pitchLabel: z.string().trim().min(L.pitchLabel.minLength).max(L.pitchLabel.maxLength).optional(),
  // Mechanics
  minCompanions: z.number().int().min(L.minCompanions.min).max(L.minCompanions.max).optional(),
  maxCompanions: z.number().int().min(L.maxCompanions.min).max(L.maxCompanions.max).optional(),
  sameDayLockoutMinutes: z
    .number()
    .int()
    .min(L.sameDayLockoutMinutes.min)
    .max(L.sameDayLockoutMinutes.max)
    .optional(),
  gracePeriodDays: z
    .number()
    .int()
    .min(L.gracePeriodDays.min)
    .max(L.gracePeriodDays.max)
    .optional(),
  // Cancellation
  allowCancelAfterFirstPunch: z.boolean().optional(),
  minCancelReasonLength: z
    .number()
    .int()
    .min(L.minCancelReasonLength.min)
    .max(L.minCancelReasonLength.max)
    .optional(),
  refundPolicyText: z.string().max(L.refundPolicyText.maxLength).optional(),
  cancelRole: z.enum(['admin', 'manager']).optional(),
  // SMS
  smsOnPurchase: z.boolean().optional(),
  smsLowEntriesThreshold: z
    .number()
    .int()
    .min(L.smsLowEntriesThreshold.min)
    .max(L.smsLowEntriesThreshold.max)
    .optional(),
  smsQuietStartMinutes: z
    .number()
    .int()
    .min(L.smsQuietMinutes.min)
    .max(L.smsQuietMinutes.max)
    .optional(),
  smsQuietEndMinutes: z
    .number()
    .int()
    .min(L.smsQuietMinutes.min)
    .max(L.smsQuietMinutes.max)
    .optional(),
  // Operational + customer
  expiryBadgeThresholdDays: z
    .number()
    .int()
    .min(L.expiryBadgeThresholdDays.min)
    .max(L.expiryBadgeThresholdDays.max)
    .optional(),
  requireEmailOnNewCustomer: z.boolean().optional(),
  requireChildOnNewCustomer: z.boolean().optional(),
  // Cashier anti-fraud controls
  requireReceiptNumberOnPos: z.boolean().optional(),
  requireSellerPin: z.boolean().optional(),
  pinLength: z.number().int().min(L.pinLength.min).max(L.pinLength.max).optional(),
  pinMemoryMinutes: z
    .number()
    .int()
    .min(L.pinMemoryMinutes.min)
    .max(L.pinMemoryMinutes.max)
    .optional(),
  pinMaxFailures: z
    .number()
    .int()
    .min(L.pinMaxFailures.min)
    .max(L.pinMaxFailures.max)
    .optional(),
  pinLockoutMinutes: z
    .number()
    .int()
    .min(L.pinLockoutMinutes.min)
    .max(L.pinLockoutMinutes.max)
    .optional(),
  // Editable customer-facing copy
  posNameOnReceiptLabel: z
    .string()
    .trim()
    .min(L.posNameOnReceiptLabel.minLength)
    .max(L.posNameOnReceiptLabel.maxLength)
    .optional(),
  posEmailNudgeText: z
    .string()
    .trim()
    .min(L.posEmailNudgeText.minLength)
    .max(L.posEmailNudgeText.maxLength)
    .optional(),
  emailOtpSubject: z
    .string()
    .trim()
    .min(L.emailOtpSubject.minLength)
    .max(L.emailOtpSubject.maxLength)
    .optional(),
  // Body template uses .max only (no trim) so the user's leading whitespace
  // and trailing newlines are preserved exactly as written.
  emailOtpBodyTemplate: z
    .string()
    .min(L.emailOtpBodyTemplate.minLength)
    .max(L.emailOtpBodyTemplate.maxLength)
    .optional(),
});

const validationStatus: Record<CardSettingsValidationError, number> = {
  price_out_of_range: 400,
  validity_out_of_range: 400,
  entries_out_of_range: 400,
  pitch_length: 400,
  min_companions_out_of_range: 400,
  max_companions_out_of_range: 400,
  companion_range_invalid: 400,
  lockout_out_of_range: 400,
  grace_out_of_range: 400,
  cancel_reason_length_out_of_range: 400,
  refund_policy_too_long: 400,
  cancel_role_invalid: 400,
  sms_low_entries_out_of_range: 400,
  sms_quiet_minutes_out_of_range: 400,
  expiry_badge_out_of_range: 400,
  pin_length_out_of_range: 400,
  pin_memory_out_of_range: 400,
  pin_max_failures_out_of_range: 400,
  pin_lockout_out_of_range: 400,
  pos_name_on_receipt_label_length: 400,
  pos_email_nudge_text_length: 400,
  email_otp_subject_length: 400,
  email_otp_body_template_length: 400,
  email_otp_body_template_unknown_placeholder: 400,
  no_changes: 409,
};

export const cardSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  // Read full settings — admin-only edit surface needs every field.
  fastify.get('/admin/card-settings', { preHandler: requireRoleHook('admin') }, async (request) => {
    const settings = await getCardSettings(db);
    request.log.info('[card-settings get]');
    return { settings };
  });

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

  // Public read for the POS sell screen — only customer-facing fields.
  fastify.get('/pos/card-pricing', { preHandler: requireRoleHook(...STAFF) }, async () => {
    const settings = await getCardSettings(db);
    return { priceShekels: settings.priceShekels, pitchLabel: settings.pitchLabel };
  });

  // Customer form rules — drives the asterisks on the new-customer form so
  // the frontend doesn't have to re-derive them.
  fastify.get(
    '/pos/customer-form-rules',
    { preHandler: requireRoleHook(...STAFF) },
    async () => {
      const settings = await getCardSettings(db);
      return {
        requireEmail: settings.requireEmailOnNewCustomer,
        requireChild: settings.requireChildOnNewCustomer,
      };
    },
  );

  // Cancel-context for the admin cancel modal — surfaces the configured
  // refund policy + min reason length + allow-after-punch flag so the cashier
  // sees the policy text and clear validation rules before submitting.
  fastify.get(
    '/admin/cancel-context',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async () => {
      const settings = await getCardSettings(db);
      return {
        refundPolicyText: settings.refundPolicyText,
        minCancelReasonLength: settings.minCancelReasonLength,
        allowCancelAfterFirstPunch: settings.allowCancelAfterFirstPunch,
        cancelRole: settings.cancelRole,
      };
    },
  );

  // Companion limits — exposed so the POS modal's +/- buttons know the
  // current min/max without admin scope.
  fastify.get(
    '/pos/companion-limits',
    { preHandler: requireRoleHook(...STAFF) },
    async () => {
      const settings = await getCardSettings(db);
      return { min: settings.minCompanions, max: settings.maxCompanions };
    },
  );

  // Sell-flow controls — receipt-number + PIN policy + the editable
  // customer-facing copy. Exposed at staff scope so the POS sell modal can
  // render the right inputs and the right Hebrew labels without round-
  // tripping through /admin/card-settings.
  fastify.get(
    '/pos/sell-controls',
    { preHandler: requireRoleHook(...STAFF) },
    async () => {
      const settings = await getCardSettings(db);
      return {
        requireReceiptNumberOnPos: settings.requireReceiptNumberOnPos,
        requireSellerPin: settings.requireSellerPin,
        pinLength: settings.pinLength,
        pinMemoryMinutes: settings.pinMemoryMinutes,
        nameOnReceiptLabel: settings.posNameOnReceiptLabel,
        emailNudgeText: settings.posEmailNudgeText,
      };
    },
  );
};
