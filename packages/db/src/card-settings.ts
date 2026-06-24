import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { logStaffAction } from './actions';
import { validateEmailOtpTemplate } from './email-otp';
import { validateHandoffThankyouTemplate } from './handoff-thankyou';
import { cardSettings, type CardSettingsRow } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type CancelRole = 'admin' | 'manager';

// Range guards mirror the zod schema in apps/api/src/routes/card-settings.ts.
// Server is the source of truth; the frontend's validation is a UX nicety.
export const CARD_SETTINGS_LIMITS = {
  priceShekels: { min: 0, max: 10000 },
  // 0 = "forever" (cards created with no expiresAt). 1..3650 = limited.
  validityDays: { min: 0, max: 3650 },
  totalEntries: { min: 1, max: 100 },
  pitchLabel: { minLength: 1, maxLength: 200 },
  sameDayLockoutMinutes: { min: 0, max: 1440 },
  gracePeriodDays: { min: 0, max: 90 },
  minCancelReasonLength: { min: 1, max: 500 },
  refundPolicyText: { maxLength: 2000 },
  smsLowEntriesThreshold: { min: 0, max: 100 },
  smsQuietMinutes: { min: 0, max: 1439 },
  expiryBadgeThresholdDays: { min: 0, max: 365 },
  // 3 ≤ PIN ≤ 12 digits; 6 is plenty for high-security setups, 3 keeps the
  // till fast when many sales fly past.
  pinLength: { min: 3, max: 12 },
  pinMemoryMinutes: { min: 1, max: 60 },
  pinMaxFailures: { min: 1, max: 10 },
  pinLockoutMinutes: { min: 1, max: 60 },
  posNameOnReceiptLabel: { minLength: 1, maxLength: 200 },
  posEmailNudgeText: { minLength: 1, maxLength: 500 },
  emailOtpSubject: { minLength: 1, maxLength: 200 },
  emailOtpBodyTemplate: { minLength: 1, maxLength: 2000 },
  checkoutThankyouTitle: { minLength: 1, maxLength: 200 },
  checkoutThankyouBody: { minLength: 1, maxLength: 2000 },
  checkoutThankyouButtonText: { minLength: 1, maxLength: 100 },
} as const;

export type CardSettingsValidationError =
  | 'price_out_of_range'
  | 'validity_out_of_range'
  | 'entries_out_of_range'
  | 'pitch_length'
  | 'lockout_out_of_range'
  | 'grace_out_of_range'
  | 'cancel_reason_length_out_of_range'
  | 'refund_policy_too_long'
  | 'cancel_role_invalid'
  | 'sms_low_entries_out_of_range'
  | 'sms_quiet_minutes_out_of_range'
  | 'expiry_badge_out_of_range'
  | 'pin_length_out_of_range'
  | 'pin_memory_out_of_range'
  | 'pin_max_failures_out_of_range'
  | 'pin_lockout_out_of_range'
  | 'pos_name_on_receipt_label_length'
  | 'pos_email_nudge_text_length'
  | 'email_otp_subject_length'
  | 'email_otp_body_template_length'
  | 'email_otp_body_template_unknown_placeholder'
  | 'checkout_thankyou_title_length'
  | 'checkout_thankyou_title_unknown_placeholder'
  | 'checkout_thankyou_body_length'
  | 'checkout_thankyou_body_unknown_placeholder'
  | 'checkout_thankyou_button_text_length'
  | 'no_changes';

/**
 * Read the singleton settings row. Lazy-init: if the migration seed somehow
 * missed (fresh pglite test DB, manually-applied migration), insert defaults
 * on the first read so callers always get a row back.
 */
export const getCardSettings = async (db: AnyPgDatabase): Promise<CardSettingsRow> => {
  const rows = await db.select().from(cardSettings).limit(1);
  const existing = rows[0];
  if (existing) return existing;
  const inserted = await db.insert(cardSettings).values({}).returning();
  const row = inserted[0];
  if (!row) throw new Error('[getCardSettings] insert returned no row');
  return row;
};

export interface UpdateCardSettingsInput {
  // Pricing + lifetime
  priceShekels?: number | undefined;
  validityDays?: number | undefined;
  totalEntries?: number | undefined;
  pitchLabel?: string | undefined;
  // Mechanics
  sameDayLockoutMinutes?: number | undefined;
  gracePeriodDays?: number | undefined;
  // Cancellation & refunds
  allowCancelAfterFirstPunch?: boolean | undefined;
  minCancelReasonLength?: number | undefined;
  refundPolicyText?: string | undefined;
  cancelRole?: CancelRole | undefined;
  // SMS + email
  smsOnPurchase?: boolean | undefined;
  emailOnPurchase?: boolean | undefined;
  smsLowEntriesThreshold?: number | undefined;
  smsQuietStartMinutes?: number | undefined;
  smsQuietEndMinutes?: number | undefined;
  // Operational + customer rules
  expiryBadgeThresholdDays?: number | undefined;
  requireEmailOnNewCustomer?: boolean | undefined;
  requireChildOnNewCustomer?: boolean | undefined;
  // Cashier anti-fraud controls
  requireReceiptNumberOnPos?: boolean | undefined;
  requireSellerPin?: boolean | undefined;
  pinLength?: number | undefined;
  pinMemoryMinutes?: number | undefined;
  pinMaxFailures?: number | undefined;
  pinLockoutMinutes?: number | undefined;
  // Editable customer-facing copy
  posNameOnReceiptLabel?: string | undefined;
  posEmailNudgeText?: string | undefined;
  emailOtpSubject?: string | undefined;
  emailOtpBodyTemplate?: string | undefined;
  // Editable thank-you page shown after a successful WooCommerce checkout
  // (my.memesh.co.il/checkout-complete). Title + body support {{firstName}}.
  checkoutThankyouTitle?: string | undefined;
  checkoutThankyouBody?: string | undefined;
  checkoutThankyouButtonText?: string | undefined;

  /** Staff member making the change; recorded on the row and in the action log. */
  staffId?: string | undefined;
  /** Override `now` for tests. */
  now?: Date;
}

export type UpdateCardSettingsResult =
  | { ok: true; row: CardSettingsRow; diff: Record<string, [unknown, unknown]> }
  | { ok: false; error: CardSettingsValidationError };

const within = (v: number, min: number, max: number): boolean =>
  Number.isInteger(v) && v >= min && v <= max;

/**
 * Update the singleton settings row. Validates ranges, records who changed
 * what, and writes a staff_actions log entry with a human-readable diff.
 *
 * Returns `no_changes` if the patch leaves every value identical to current —
 * the caller can surface that as a UX hint without writing to the audit log.
 */
export const updateCardSettings = async (
  db: AnyPgDatabase,
  input: UpdateCardSettingsInput,
): Promise<UpdateCardSettingsResult> => {
  const L = CARD_SETTINGS_LIMITS;

  // Range guards first — fail fast before touching the row.
  if (input.priceShekels !== undefined && !within(input.priceShekels, L.priceShekels.min, L.priceShekels.max)) {
    return { ok: false, error: 'price_out_of_range' };
  }
  if (input.validityDays !== undefined && !within(input.validityDays, L.validityDays.min, L.validityDays.max)) {
    return { ok: false, error: 'validity_out_of_range' };
  }
  if (input.totalEntries !== undefined && !within(input.totalEntries, L.totalEntries.min, L.totalEntries.max)) {
    return { ok: false, error: 'entries_out_of_range' };
  }
  if (input.pitchLabel !== undefined) {
    const trimmed = input.pitchLabel.trim();
    if (trimmed.length < L.pitchLabel.minLength || trimmed.length > L.pitchLabel.maxLength) {
      return { ok: false, error: 'pitch_length' };
    }
  }
  if (input.sameDayLockoutMinutes !== undefined && !within(input.sameDayLockoutMinutes, L.sameDayLockoutMinutes.min, L.sameDayLockoutMinutes.max)) {
    return { ok: false, error: 'lockout_out_of_range' };
  }
  if (input.gracePeriodDays !== undefined && !within(input.gracePeriodDays, L.gracePeriodDays.min, L.gracePeriodDays.max)) {
    return { ok: false, error: 'grace_out_of_range' };
  }
  if (input.minCancelReasonLength !== undefined && !within(input.minCancelReasonLength, L.minCancelReasonLength.min, L.minCancelReasonLength.max)) {
    return { ok: false, error: 'cancel_reason_length_out_of_range' };
  }
  if (input.refundPolicyText !== undefined && input.refundPolicyText.length > L.refundPolicyText.maxLength) {
    return { ok: false, error: 'refund_policy_too_long' };
  }
  if (input.cancelRole !== undefined && input.cancelRole !== 'admin' && input.cancelRole !== 'manager') {
    return { ok: false, error: 'cancel_role_invalid' };
  }
  if (input.smsLowEntriesThreshold !== undefined && !within(input.smsLowEntriesThreshold, L.smsLowEntriesThreshold.min, L.smsLowEntriesThreshold.max)) {
    return { ok: false, error: 'sms_low_entries_out_of_range' };
  }
  if (input.smsQuietStartMinutes !== undefined && !within(input.smsQuietStartMinutes, L.smsQuietMinutes.min, L.smsQuietMinutes.max)) {
    return { ok: false, error: 'sms_quiet_minutes_out_of_range' };
  }
  if (input.smsQuietEndMinutes !== undefined && !within(input.smsQuietEndMinutes, L.smsQuietMinutes.min, L.smsQuietMinutes.max)) {
    return { ok: false, error: 'sms_quiet_minutes_out_of_range' };
  }
  if (input.expiryBadgeThresholdDays !== undefined && !within(input.expiryBadgeThresholdDays, L.expiryBadgeThresholdDays.min, L.expiryBadgeThresholdDays.max)) {
    return { ok: false, error: 'expiry_badge_out_of_range' };
  }
  if (input.pinLength !== undefined && !within(input.pinLength, L.pinLength.min, L.pinLength.max)) {
    return { ok: false, error: 'pin_length_out_of_range' };
  }
  if (input.pinMemoryMinutes !== undefined && !within(input.pinMemoryMinutes, L.pinMemoryMinutes.min, L.pinMemoryMinutes.max)) {
    return { ok: false, error: 'pin_memory_out_of_range' };
  }
  if (input.pinMaxFailures !== undefined && !within(input.pinMaxFailures, L.pinMaxFailures.min, L.pinMaxFailures.max)) {
    return { ok: false, error: 'pin_max_failures_out_of_range' };
  }
  if (input.pinLockoutMinutes !== undefined && !within(input.pinLockoutMinutes, L.pinLockoutMinutes.min, L.pinLockoutMinutes.max)) {
    return { ok: false, error: 'pin_lockout_out_of_range' };
  }
  if (input.posNameOnReceiptLabel !== undefined) {
    const trimmed = input.posNameOnReceiptLabel.trim();
    if (trimmed.length < L.posNameOnReceiptLabel.minLength || trimmed.length > L.posNameOnReceiptLabel.maxLength) {
      return { ok: false, error: 'pos_name_on_receipt_label_length' };
    }
  }
  if (input.posEmailNudgeText !== undefined) {
    const trimmed = input.posEmailNudgeText.trim();
    if (trimmed.length < L.posEmailNudgeText.minLength || trimmed.length > L.posEmailNudgeText.maxLength) {
      return { ok: false, error: 'pos_email_nudge_text_length' };
    }
  }
  if (input.emailOtpSubject !== undefined) {
    const trimmed = input.emailOtpSubject.trim();
    if (trimmed.length < L.emailOtpSubject.minLength || trimmed.length > L.emailOtpSubject.maxLength) {
      return { ok: false, error: 'email_otp_subject_length' };
    }
  }
  if (input.emailOtpBodyTemplate !== undefined) {
    // Length check first (cheap), then placeholder validation (refuses
    // unknown tokens so a typo can't silently break OTPs in production).
    if (input.emailOtpBodyTemplate.length < L.emailOtpBodyTemplate.minLength || input.emailOtpBodyTemplate.length > L.emailOtpBodyTemplate.maxLength) {
      return { ok: false, error: 'email_otp_body_template_length' };
    }
    const placeholderCheck = validateEmailOtpTemplate(input.emailOtpBodyTemplate);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'email_otp_body_template_unknown_placeholder' };
    }
  }
  if (input.checkoutThankyouTitle !== undefined) {
    const trimmed = input.checkoutThankyouTitle.trim();
    if (trimmed.length < L.checkoutThankyouTitle.minLength || trimmed.length > L.checkoutThankyouTitle.maxLength) {
      return { ok: false, error: 'checkout_thankyou_title_length' };
    }
    const placeholderCheck = validateHandoffThankyouTemplate(trimmed);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'checkout_thankyou_title_unknown_placeholder' };
    }
  }
  if (input.checkoutThankyouBody !== undefined) {
    if (input.checkoutThankyouBody.length < L.checkoutThankyouBody.minLength || input.checkoutThankyouBody.length > L.checkoutThankyouBody.maxLength) {
      return { ok: false, error: 'checkout_thankyou_body_length' };
    }
    const placeholderCheck = validateHandoffThankyouTemplate(input.checkoutThankyouBody);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'checkout_thankyou_body_unknown_placeholder' };
    }
  }
  if (input.checkoutThankyouButtonText !== undefined) {
    const trimmed = input.checkoutThankyouButtonText.trim();
    if (trimmed.length < L.checkoutThankyouButtonText.minLength || trimmed.length > L.checkoutThankyouButtonText.maxLength) {
      return { ok: false, error: 'checkout_thankyou_button_text_length' };
    }
  }

  const now = input.now ?? new Date();
  const current = await getCardSettings(db);

  const next: Partial<typeof cardSettings.$inferInsert> = {};
  const diff: Record<string, [unknown, unknown]> = {};

  const assignNumber = (key: keyof typeof current & keyof typeof next, value: number | undefined) => {
    if (value === undefined) return;
    if (value === (current[key] as number)) return;
    (next as Record<string, unknown>)[key] = value;
    diff[key as string] = [current[key], value];
  };
  const assignBool = (key: keyof typeof current & keyof typeof next, value: boolean | undefined) => {
    if (value === undefined) return;
    if (value === (current[key] as boolean)) return;
    (next as Record<string, unknown>)[key] = value;
    diff[key as string] = [current[key], value];
  };
  const assignString = (key: keyof typeof current & keyof typeof next, value: string | undefined) => {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed === (current[key] as string)) return;
    (next as Record<string, unknown>)[key] = trimmed;
    diff[key as string] = [current[key], trimmed];
  };
  const assignStringRaw = (key: keyof typeof current & keyof typeof next, value: string | undefined) => {
    // For refund policy text — preserve user newlines/spaces, just compare raw.
    if (value === undefined) return;
    if (value === (current[key] as string)) return;
    (next as Record<string, unknown>)[key] = value;
    diff[key as string] = [current[key], value];
  };

  assignNumber('priceShekels', input.priceShekels);
  assignNumber('validityDays', input.validityDays);
  assignNumber('totalEntries', input.totalEntries);
  assignString('pitchLabel', input.pitchLabel);
  assignNumber('sameDayLockoutMinutes', input.sameDayLockoutMinutes);
  assignNumber('gracePeriodDays', input.gracePeriodDays);
  assignBool('allowCancelAfterFirstPunch', input.allowCancelAfterFirstPunch);
  assignNumber('minCancelReasonLength', input.minCancelReasonLength);
  assignStringRaw('refundPolicyText', input.refundPolicyText);
  if (input.cancelRole !== undefined && input.cancelRole !== current.cancelRole) {
    next.cancelRole = input.cancelRole;
    diff.cancelRole = [current.cancelRole, input.cancelRole];
  }
  assignBool('smsOnPurchase', input.smsOnPurchase);
  assignBool('emailOnPurchase', input.emailOnPurchase);
  assignNumber('smsLowEntriesThreshold', input.smsLowEntriesThreshold);
  assignNumber('smsQuietStartMinutes', input.smsQuietStartMinutes);
  assignNumber('smsQuietEndMinutes', input.smsQuietEndMinutes);
  assignNumber('expiryBadgeThresholdDays', input.expiryBadgeThresholdDays);
  assignBool('requireEmailOnNewCustomer', input.requireEmailOnNewCustomer);
  assignBool('requireChildOnNewCustomer', input.requireChildOnNewCustomer);
  assignBool('requireReceiptNumberOnPos', input.requireReceiptNumberOnPos);
  assignBool('requireSellerPin', input.requireSellerPin);
  assignNumber('pinLength', input.pinLength);
  assignNumber('pinMemoryMinutes', input.pinMemoryMinutes);
  assignNumber('pinMaxFailures', input.pinMaxFailures);
  assignNumber('pinLockoutMinutes', input.pinLockoutMinutes);
  assignString('posNameOnReceiptLabel', input.posNameOnReceiptLabel);
  assignString('posEmailNudgeText', input.posEmailNudgeText);
  assignString('emailOtpSubject', input.emailOtpSubject);
  // Body template uses assignStringRaw to preserve user newlines + leading
  // whitespace inside the email body.
  assignStringRaw('emailOtpBodyTemplate', input.emailOtpBodyTemplate);
  assignString('checkoutThankyouTitle', input.checkoutThankyouTitle);
  // Body uses assignStringRaw to preserve user newlines inside the thank-you
  // copy (operators may want a paragraph break before the CTA).
  assignStringRaw('checkoutThankyouBody', input.checkoutThankyouBody);
  assignString('checkoutThankyouButtonText', input.checkoutThankyouButtonText);

  if (Object.keys(diff).length === 0) return { ok: false, error: 'no_changes' };

  next.updatedAt = now;
  if (input.staffId !== undefined) next.updatedBy = input.staffId;

  const rows = await db
    .update(cardSettings)
    .set(next)
    .where(eq(cardSettings.id, current.id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('[updateCardSettings] update returned no row');

  await logStaffAction(db, {
    action: 'update_card_settings',
    summary: summarizeDiff(diff),
    now,
    ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
  });

  return { ok: true, row, diff };
};

// Hebrew-facing summary line for the staff_actions log. We surface the
// most-meaningful renames here; rarely-touched flags collapse into a count
// to keep the line readable when many fields change at once.
const FIELD_LABELS: Record<string, string> = {
  priceShekels: 'מחיר',
  validityDays: 'תוקף',
  totalEntries: 'כניסות',
  pitchLabel: 'טקסט שיווקי',
  sameDayLockoutMinutes: 'נעילת רה-ניקוב',
  gracePeriodDays: 'תקופת חסד',
  allowCancelAfterFirstPunch: 'ביטול לאחר ניקוב',
  minCancelReasonLength: 'אורך סיבת ביטול',
  refundPolicyText: 'מדיניות החזרים',
  cancelRole: 'הרשאת ביטול',
  smsOnPurchase: 'SMS במכירה',
  emailOnPurchase: 'מייל במכירה',
  smsLowEntriesThreshold: 'SMS כניסות נמוכות',
  smsQuietStartMinutes: 'התחלת שעות שקט',
  smsQuietEndMinutes: 'סוף שעות שקט',
  expiryBadgeThresholdDays: 'תג פג תוקף',
  requireEmailOnNewCustomer: 'מייל חובה',
  requireChildOnNewCustomer: 'ילד חובה',
  requireReceiptNumberOnPos: 'מספר קבלה חובה',
  requireSellerPin: 'קוד קופאי חובה',
  pinLength: 'אורך קוד קופאי',
  pinMemoryMinutes: 'זיכרון קוד קופאי',
  pinMaxFailures: 'כשלים מותרים',
  pinLockoutMinutes: 'משך נעילה',
  posNameOnReceiptLabel: 'טקסט וי שם הלקוח',
  posEmailNudgeText: 'טקסט המלצת אימייל',
  emailOtpSubject: 'נושא מייל OTP',
  emailOtpBodyTemplate: 'תבנית מייל OTP',
  checkoutThankyouTitle: 'כותרת דף תודה',
  checkoutThankyouBody: 'גוף דף תודה',
  checkoutThankyouButtonText: 'כפתור דף תודה',
};

const summarizeDiff = (diff: Record<string, [unknown, unknown]>): string => {
  const parts: string[] = [];
  for (const [key, [from, to]] of Object.entries(diff)) {
    const label = FIELD_LABELS[key] ?? key;
    if (typeof from === 'boolean' || typeof to === 'boolean') {
      parts.push(`${label}: ${to ? 'הופעל' : 'בוטל'}`);
    } else if (typeof from === 'string' && typeof to === 'string' && (from.length > 30 || to.length > 30)) {
      parts.push(`${label} עודכן`);
    } else {
      parts.push(`${label} ${String(from)}→${String(to)}`);
    }
  }
  return `עדכון הגדרות כרטיסייה · ${parts.join(' · ')}`;
};

// ---------------------------------------------------------------------------
// Quiet-hours helper — used by the SMS marketing wrapper to decide whether
// the current local time falls inside the configured quiet window.
// ---------------------------------------------------------------------------

/**
 * Returns true when `now` (interpreted in Asia/Jerusalem) falls inside the
 * quiet window described by `startMinutes`–`endMinutes` (both 0–1439). The
 * window can wrap midnight: e.g. 21:00 → 09:00 means "between 21:00 and
 * 09:00 the next morning".
 */
export const isQuietHourNow = (
  startMinutes: number,
  endMinutes: number,
  now: Date = new Date(),
): boolean => {
  if (startMinutes === endMinutes) return false; // zero-width window = always off
  // Get hours/minutes in Israel timezone regardless of host TZ.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const nowMin = h * 60 + m;
  // Non-wrapping window (start < end): inside if start ≤ now < end.
  if (startMinutes < endMinutes) return nowMin >= startMinutes && nowMin < endMinutes;
  // Wrapping window (start > end): inside if now ≥ start OR now < end.
  return nowMin >= startMinutes || nowMin < endMinutes;
};
