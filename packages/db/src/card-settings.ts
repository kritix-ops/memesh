import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { logStaffAction } from './actions';
import { validateEmailOtpTemplate } from './email-otp';
import { validateGiftTemplate } from './gift-template';
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
  emailOnPurchaseSubject: { minLength: 1, maxLength: 200 },
  emailOnPurchaseHeadline: { minLength: 1, maxLength: 200 },
  emailOnPurchaseIntro: { minLength: 1, maxLength: 500 },
  emailOnPurchaseCtaText: { minLength: 1, maxLength: 60 },
  emailOnPurchaseFooterNote: { minLength: 1, maxLength: 500 },
  // Gift card flow (2026-06-24). TTL upper bound is 5 years — long enough
  // for the most generous gifting policy without inviting clutter on the
  // pending-claim table.
  giftClaimTtlDays: { min: 1, max: 1825 },
  giftRecipientEmailSubject: { minLength: 1, maxLength: 200 },
  giftRecipientEmailHeadline: { minLength: 1, maxLength: 200 },
  giftRecipientEmailIntro: { minLength: 1, maxLength: 500 },
  giftRecipientEmailMagicCtaText: { minLength: 1, maxLength: 60 },
  giftRecipientEmailClaimCtaText: { minLength: 1, maxLength: 60 },
  giftRecipientEmailFooterNote: { minLength: 1, maxLength: 500 },
  giftBuyerEmailSubject: { minLength: 1, maxLength: 200 },
  giftBuyerEmailHeadline: { minLength: 1, maxLength: 200 },
  giftBuyerEmailIntro: { minLength: 1, maxLength: 500 },
  giftBuyerEmailFooterNote: { minLength: 1, maxLength: 500 },
  giftBuyerClaimEmailSubject: { minLength: 1, maxLength: 200 },
  giftBuyerClaimEmailHeadline: { minLength: 1, maxLength: 200 },
  giftBuyerClaimEmailIntro: { minLength: 1, maxLength: 500 },
  giftBuyerClaimEmailFooterNote: { minLength: 1, maxLength: 500 },
  // Round entry pricing (2026-07-02, step 3b). 0..1000 covers the entire
  // realistic price range for a play-area single entry; the DB CHECK
  // enforces >= 0 as a floor.
  roundChildBabyPriceIls: { min: 0, max: 1000 },
  roundChildOverWalkingPriceIls: { min: 0, max: 1000 },
  roundAdditionalCompanionPriceIls: { min: 0, max: 1000 },
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
  | 'email_on_purchase_subject_length'
  | 'email_on_purchase_subject_unknown_placeholder'
  | 'email_on_purchase_headline_length'
  | 'email_on_purchase_headline_unknown_placeholder'
  | 'email_on_purchase_intro_length'
  | 'email_on_purchase_intro_unknown_placeholder'
  | 'email_on_purchase_cta_text_length'
  | 'email_on_purchase_footer_note_length'
  | 'gift_claim_ttl_out_of_range'
  | 'gift_recipient_email_subject_length'
  | 'gift_recipient_email_subject_unknown_placeholder'
  | 'gift_recipient_email_headline_length'
  | 'gift_recipient_email_headline_unknown_placeholder'
  | 'gift_recipient_email_intro_length'
  | 'gift_recipient_email_intro_unknown_placeholder'
  | 'gift_recipient_email_magic_cta_text_length'
  | 'gift_recipient_email_claim_cta_text_length'
  | 'gift_recipient_email_footer_note_length'
  | 'gift_buyer_email_subject_length'
  | 'gift_buyer_email_subject_unknown_placeholder'
  | 'gift_buyer_email_headline_length'
  | 'gift_buyer_email_intro_length'
  | 'gift_buyer_email_intro_unknown_placeholder'
  | 'gift_buyer_email_footer_note_length'
  | 'gift_buyer_claim_email_subject_length'
  | 'gift_buyer_claim_email_subject_unknown_placeholder'
  | 'gift_buyer_claim_email_headline_length'
  | 'gift_buyer_claim_email_intro_length'
  | 'gift_buyer_claim_email_intro_unknown_placeholder'
  | 'gift_buyer_claim_email_footer_note_length'
  | 'round_child_baby_price_out_of_range'
  | 'round_child_over_walking_price_out_of_range'
  | 'round_additional_companion_price_out_of_range'
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
  // Editable post-purchase email copy (2026-06-24). Subject + headline +
  // intro support {{firstName}}; CTA + footer are plain text. Visual
  // structure (logo, colors, layout) stays in code.
  emailOnPurchaseSubject?: string | undefined;
  emailOnPurchaseHeadline?: string | undefined;
  emailOnPurchaseIntro?: string | undefined;
  emailOnPurchaseCtaText?: string | undefined;
  emailOnPurchaseFooterNote?: string | undefined;
  // Gift card flow (2026-06-24). Three toggles + editable copy across three
  // email variants — see _plans/2026-06-24-gift-card-checkout.md.
  giftCardsEnabled?: boolean | undefined;
  giftClaimTtlDays?: number | undefined;
  giftBuyerNotifyOnClaim?: boolean | undefined;
  giftRecipientEmailSubject?: string | undefined;
  giftRecipientEmailHeadline?: string | undefined;
  giftRecipientEmailIntro?: string | undefined;
  giftRecipientEmailMagicCtaText?: string | undefined;
  giftRecipientEmailClaimCtaText?: string | undefined;
  giftRecipientEmailFooterNote?: string | undefined;
  giftBuyerEmailSubject?: string | undefined;
  giftBuyerEmailHeadline?: string | undefined;
  giftBuyerEmailIntro?: string | undefined;
  giftBuyerEmailFooterNote?: string | undefined;
  giftBuyerClaimEmailSubject?: string | undefined;
  giftBuyerClaimEmailHeadline?: string | undefined;
  giftBuyerClaimEmailIntro?: string | undefined;
  giftBuyerClaimEmailFooterNote?: string | undefined;
  // Round entry pricing (2026-07-02, step 3b). Used by dashboardLiveStats
  // to compute today's revenue from booking counts.
  roundChildBabyPriceIls?: number | undefined;
  roundChildOverWalkingPriceIls?: number | undefined;
  roundAdditionalCompanionPriceIls?: number | undefined;

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
  if (input.emailOnPurchaseSubject !== undefined) {
    const trimmed = input.emailOnPurchaseSubject.trim();
    if (trimmed.length < L.emailOnPurchaseSubject.minLength || trimmed.length > L.emailOnPurchaseSubject.maxLength) {
      return { ok: false, error: 'email_on_purchase_subject_length' };
    }
    const placeholderCheck = validateHandoffThankyouTemplate(trimmed);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'email_on_purchase_subject_unknown_placeholder' };
    }
  }
  if (input.emailOnPurchaseHeadline !== undefined) {
    const trimmed = input.emailOnPurchaseHeadline.trim();
    if (trimmed.length < L.emailOnPurchaseHeadline.minLength || trimmed.length > L.emailOnPurchaseHeadline.maxLength) {
      return { ok: false, error: 'email_on_purchase_headline_length' };
    }
    const placeholderCheck = validateHandoffThankyouTemplate(trimmed);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'email_on_purchase_headline_unknown_placeholder' };
    }
  }
  if (input.emailOnPurchaseIntro !== undefined) {
    if (input.emailOnPurchaseIntro.length < L.emailOnPurchaseIntro.minLength || input.emailOnPurchaseIntro.length > L.emailOnPurchaseIntro.maxLength) {
      return { ok: false, error: 'email_on_purchase_intro_length' };
    }
    const placeholderCheck = validateHandoffThankyouTemplate(input.emailOnPurchaseIntro);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'email_on_purchase_intro_unknown_placeholder' };
    }
  }
  if (input.emailOnPurchaseCtaText !== undefined) {
    const trimmed = input.emailOnPurchaseCtaText.trim();
    if (trimmed.length < L.emailOnPurchaseCtaText.minLength || trimmed.length > L.emailOnPurchaseCtaText.maxLength) {
      return { ok: false, error: 'email_on_purchase_cta_text_length' };
    }
  }
  if (input.emailOnPurchaseFooterNote !== undefined) {
    if (input.emailOnPurchaseFooterNote.length < L.emailOnPurchaseFooterNote.minLength || input.emailOnPurchaseFooterNote.length > L.emailOnPurchaseFooterNote.maxLength) {
      return { ok: false, error: 'email_on_purchase_footer_note_length' };
    }
  }

  // --- Gift card settings (2026-06-24) ---
  if (input.giftClaimTtlDays !== undefined && !within(input.giftClaimTtlDays, L.giftClaimTtlDays.min, L.giftClaimTtlDays.max)) {
    return { ok: false, error: 'gift_claim_ttl_out_of_range' };
  }
  if (input.giftRecipientEmailSubject !== undefined) {
    const trimmed = input.giftRecipientEmailSubject.trim();
    if (trimmed.length < L.giftRecipientEmailSubject.minLength || trimmed.length > L.giftRecipientEmailSubject.maxLength) {
      return { ok: false, error: 'gift_recipient_email_subject_length' };
    }
    const placeholderCheck = validateGiftTemplate(trimmed);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'gift_recipient_email_subject_unknown_placeholder' };
    }
  }
  if (input.giftRecipientEmailHeadline !== undefined) {
    const trimmed = input.giftRecipientEmailHeadline.trim();
    if (trimmed.length < L.giftRecipientEmailHeadline.minLength || trimmed.length > L.giftRecipientEmailHeadline.maxLength) {
      return { ok: false, error: 'gift_recipient_email_headline_length' };
    }
    const placeholderCheck = validateGiftTemplate(trimmed);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'gift_recipient_email_headline_unknown_placeholder' };
    }
  }
  if (input.giftRecipientEmailIntro !== undefined) {
    if (input.giftRecipientEmailIntro.length < L.giftRecipientEmailIntro.minLength || input.giftRecipientEmailIntro.length > L.giftRecipientEmailIntro.maxLength) {
      return { ok: false, error: 'gift_recipient_email_intro_length' };
    }
    const placeholderCheck = validateGiftTemplate(input.giftRecipientEmailIntro);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'gift_recipient_email_intro_unknown_placeholder' };
    }
  }
  if (input.giftRecipientEmailMagicCtaText !== undefined) {
    const trimmed = input.giftRecipientEmailMagicCtaText.trim();
    if (trimmed.length < L.giftRecipientEmailMagicCtaText.minLength || trimmed.length > L.giftRecipientEmailMagicCtaText.maxLength) {
      return { ok: false, error: 'gift_recipient_email_magic_cta_text_length' };
    }
  }
  if (input.giftRecipientEmailClaimCtaText !== undefined) {
    const trimmed = input.giftRecipientEmailClaimCtaText.trim();
    if (trimmed.length < L.giftRecipientEmailClaimCtaText.minLength || trimmed.length > L.giftRecipientEmailClaimCtaText.maxLength) {
      return { ok: false, error: 'gift_recipient_email_claim_cta_text_length' };
    }
  }
  if (input.giftRecipientEmailFooterNote !== undefined) {
    if (input.giftRecipientEmailFooterNote.length < L.giftRecipientEmailFooterNote.minLength || input.giftRecipientEmailFooterNote.length > L.giftRecipientEmailFooterNote.maxLength) {
      return { ok: false, error: 'gift_recipient_email_footer_note_length' };
    }
  }
  if (input.giftBuyerEmailSubject !== undefined) {
    const trimmed = input.giftBuyerEmailSubject.trim();
    if (trimmed.length < L.giftBuyerEmailSubject.minLength || trimmed.length > L.giftBuyerEmailSubject.maxLength) {
      return { ok: false, error: 'gift_buyer_email_subject_length' };
    }
    const placeholderCheck = validateGiftTemplate(trimmed);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'gift_buyer_email_subject_unknown_placeholder' };
    }
  }
  if (input.giftBuyerEmailHeadline !== undefined) {
    const trimmed = input.giftBuyerEmailHeadline.trim();
    if (trimmed.length < L.giftBuyerEmailHeadline.minLength || trimmed.length > L.giftBuyerEmailHeadline.maxLength) {
      return { ok: false, error: 'gift_buyer_email_headline_length' };
    }
  }
  if (input.giftBuyerEmailIntro !== undefined) {
    if (input.giftBuyerEmailIntro.length < L.giftBuyerEmailIntro.minLength || input.giftBuyerEmailIntro.length > L.giftBuyerEmailIntro.maxLength) {
      return { ok: false, error: 'gift_buyer_email_intro_length' };
    }
    const placeholderCheck = validateGiftTemplate(input.giftBuyerEmailIntro);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'gift_buyer_email_intro_unknown_placeholder' };
    }
  }
  if (input.giftBuyerEmailFooterNote !== undefined) {
    if (input.giftBuyerEmailFooterNote.length < L.giftBuyerEmailFooterNote.minLength || input.giftBuyerEmailFooterNote.length > L.giftBuyerEmailFooterNote.maxLength) {
      return { ok: false, error: 'gift_buyer_email_footer_note_length' };
    }
  }
  if (input.giftBuyerClaimEmailSubject !== undefined) {
    const trimmed = input.giftBuyerClaimEmailSubject.trim();
    if (trimmed.length < L.giftBuyerClaimEmailSubject.minLength || trimmed.length > L.giftBuyerClaimEmailSubject.maxLength) {
      return { ok: false, error: 'gift_buyer_claim_email_subject_length' };
    }
    const placeholderCheck = validateGiftTemplate(trimmed);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'gift_buyer_claim_email_subject_unknown_placeholder' };
    }
  }
  if (input.giftBuyerClaimEmailHeadline !== undefined) {
    const trimmed = input.giftBuyerClaimEmailHeadline.trim();
    if (trimmed.length < L.giftBuyerClaimEmailHeadline.minLength || trimmed.length > L.giftBuyerClaimEmailHeadline.maxLength) {
      return { ok: false, error: 'gift_buyer_claim_email_headline_length' };
    }
  }
  if (input.giftBuyerClaimEmailIntro !== undefined) {
    if (input.giftBuyerClaimEmailIntro.length < L.giftBuyerClaimEmailIntro.minLength || input.giftBuyerClaimEmailIntro.length > L.giftBuyerClaimEmailIntro.maxLength) {
      return { ok: false, error: 'gift_buyer_claim_email_intro_length' };
    }
    const placeholderCheck = validateGiftTemplate(input.giftBuyerClaimEmailIntro);
    if (!placeholderCheck.ok) {
      return { ok: false, error: 'gift_buyer_claim_email_intro_unknown_placeholder' };
    }
  }
  if (input.giftBuyerClaimEmailFooterNote !== undefined) {
    if (input.giftBuyerClaimEmailFooterNote.length < L.giftBuyerClaimEmailFooterNote.minLength || input.giftBuyerClaimEmailFooterNote.length > L.giftBuyerClaimEmailFooterNote.maxLength) {
      return { ok: false, error: 'gift_buyer_claim_email_footer_note_length' };
    }
  }

  // --- Round entry pricing (2026-07-02, step 3b) ---
  if (input.roundChildBabyPriceIls !== undefined && !within(input.roundChildBabyPriceIls, L.roundChildBabyPriceIls.min, L.roundChildBabyPriceIls.max)) {
    return { ok: false, error: 'round_child_baby_price_out_of_range' };
  }
  if (input.roundChildOverWalkingPriceIls !== undefined && !within(input.roundChildOverWalkingPriceIls, L.roundChildOverWalkingPriceIls.min, L.roundChildOverWalkingPriceIls.max)) {
    return { ok: false, error: 'round_child_over_walking_price_out_of_range' };
  }
  if (input.roundAdditionalCompanionPriceIls !== undefined && !within(input.roundAdditionalCompanionPriceIls, L.roundAdditionalCompanionPriceIls.min, L.roundAdditionalCompanionPriceIls.max)) {
    return { ok: false, error: 'round_additional_companion_price_out_of_range' };
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
  // Post-purchase email copy. Subject + headline + cta are trimmed; intro
  // and footer use assignStringRaw so operators can include a deliberate
  // newline (rare but allowed — they render as <br> in the HTML body).
  assignString('emailOnPurchaseSubject', input.emailOnPurchaseSubject);
  assignString('emailOnPurchaseHeadline', input.emailOnPurchaseHeadline);
  assignStringRaw('emailOnPurchaseIntro', input.emailOnPurchaseIntro);
  assignString('emailOnPurchaseCtaText', input.emailOnPurchaseCtaText);
  assignStringRaw('emailOnPurchaseFooterNote', input.emailOnPurchaseFooterNote);
  // Gift card settings (2026-06-24). Subjects/headlines/CTAs are trimmed;
  // intros + footer notes preserve operator-entered newlines so multi-line
  // copy renders as expected.
  assignBool('giftCardsEnabled', input.giftCardsEnabled);
  assignNumber('giftClaimTtlDays', input.giftClaimTtlDays);
  assignBool('giftBuyerNotifyOnClaim', input.giftBuyerNotifyOnClaim);
  assignString('giftRecipientEmailSubject', input.giftRecipientEmailSubject);
  assignString('giftRecipientEmailHeadline', input.giftRecipientEmailHeadline);
  assignStringRaw('giftRecipientEmailIntro', input.giftRecipientEmailIntro);
  assignString('giftRecipientEmailMagicCtaText', input.giftRecipientEmailMagicCtaText);
  assignString('giftRecipientEmailClaimCtaText', input.giftRecipientEmailClaimCtaText);
  assignStringRaw('giftRecipientEmailFooterNote', input.giftRecipientEmailFooterNote);
  assignString('giftBuyerEmailSubject', input.giftBuyerEmailSubject);
  assignString('giftBuyerEmailHeadline', input.giftBuyerEmailHeadline);
  assignStringRaw('giftBuyerEmailIntro', input.giftBuyerEmailIntro);
  assignStringRaw('giftBuyerEmailFooterNote', input.giftBuyerEmailFooterNote);
  assignString('giftBuyerClaimEmailSubject', input.giftBuyerClaimEmailSubject);
  assignString('giftBuyerClaimEmailHeadline', input.giftBuyerClaimEmailHeadline);
  assignStringRaw('giftBuyerClaimEmailIntro', input.giftBuyerClaimEmailIntro);
  assignStringRaw('giftBuyerClaimEmailFooterNote', input.giftBuyerClaimEmailFooterNote);
  // Round entry pricing (2026-07-02, step 3b).
  assignNumber('roundChildBabyPriceIls', input.roundChildBabyPriceIls);
  assignNumber('roundChildOverWalkingPriceIls', input.roundChildOverWalkingPriceIls);
  assignNumber('roundAdditionalCompanionPriceIls', input.roundAdditionalCompanionPriceIls);

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
  emailOnPurchaseSubject: 'נושא אימייל',
  emailOnPurchaseHeadline: 'כותרת אימייל',
  emailOnPurchaseIntro: 'גוף אימייל',
  emailOnPurchaseCtaText: 'טקסט כפתור באימייל',
  emailOnPurchaseFooterNote: 'הערת רגל באימייל',
  giftCardsEnabled: 'כרטיסיות מתנה',
  giftClaimTtlDays: 'תוקף קישור מתנה (ימים)',
  giftBuyerNotifyOnClaim: 'הודעה למזמין על פתיחת מתנה',
  giftRecipientEmailSubject: 'נושא מייל מתנה לנמען',
  giftRecipientEmailHeadline: 'כותרת מייל מתנה לנמען',
  giftRecipientEmailIntro: 'גוף מייל מתנה לנמען',
  giftRecipientEmailMagicCtaText: 'כפתור פתיחת כרטיסייה',
  giftRecipientEmailClaimCtaText: 'כפתור קבלת מתנה',
  giftRecipientEmailFooterNote: 'הערת רגל מייל לנמען',
  giftBuyerEmailSubject: 'נושא מייל מתנה למזמין',
  giftBuyerEmailHeadline: 'כותרת מייל מתנה למזמין',
  giftBuyerEmailIntro: 'גוף מייל מתנה למזמין',
  giftBuyerEmailFooterNote: 'הערת רגל מייל למזמין',
  giftBuyerClaimEmailSubject: 'נושא מייל פתיחת מתנה',
  giftBuyerClaimEmailHeadline: 'כותרת מייל פתיחת מתנה',
  giftBuyerClaimEmailIntro: 'גוף מייל פתיחת מתנה',
  giftBuyerClaimEmailFooterNote: 'הערת רגל מייל פתיחה',
  // Round entry pricing (2026-07-02, step 3b).
  roundChildBabyPriceIls: 'מחיר כרטיס תינוק/ת (₪)',
  roundChildOverWalkingPriceIls: 'מחיר כרטיס ילד/ה (₪)',
  roundAdditionalCompanionPriceIls: 'מחיר מלווה נוסף (₪)',
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
