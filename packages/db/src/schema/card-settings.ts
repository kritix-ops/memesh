import { boolean, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { staff } from './staff';

// Singleton: exactly one row, enforced by `singleton boolean UNIQUE DEFAULT true`.
// Adding `accountId` later for multi-tenant is a column add + index, no rewrite.
export const cardSettings = pgTable('card_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  singleton: boolean('singleton').notNull().default(true).unique(),

  // Pricing + lifetime (shipped with 0001)
  priceShekels: integer('price_shekels').notNull().default(320),
  validityDays: integer('validity_days').notNull().default(365),
  totalEntries: integer('total_entries').notNull().default(12),
  pitchLabel: text('pitch_label').notNull().default('משלמים על 10, מקבלים 12 · תקף לשנה'),

  // --- Card mechanics ---
  /** Minutes the cashier must wait before re-punching the same card. 0 disables. */
  sameDayLockoutMinutes: integer('same_day_lockout_minutes').notNull().default(0),
  /** Extra days past expiresAt where the card still works but is flagged 'grace'. */
  gracePeriodDays: integer('grace_period_days').notNull().default(0),

  // --- Cancellation & refunds ---
  allowCancelAfterFirstPunch: boolean('allow_cancel_after_first_punch').notNull().default(true),
  minCancelReasonLength: integer('min_cancel_reason_length').notNull().default(5),
  refundPolicyText: text('refund_policy_text').notNull().default(''),
  /** Who can cancel. 'admin' = admin only. 'manager' = admin + manager (current default). */
  cancelRole: varchar('cancel_role', { length: 16 }).notNull().default('manager'),

  // --- SMS communication ---
  smsOnPurchase: boolean('sms_on_purchase').notNull().default(true),
  /** Send a marketing SMS after a punch when remaining ≤ threshold. 0 disables. */
  smsLowEntriesThreshold: integer('sms_low_entries_threshold').notNull().default(0),
  /** Quiet hours expressed as minutes since midnight (Asia/Jerusalem). 21:00 default. */
  smsQuietStartMinutes: integer('sms_quiet_start_minutes').notNull().default(1260),
  /** 09:00 default. */
  smsQuietEndMinutes: integer('sms_quiet_end_minutes').notNull().default(540),

  // --- Operational UX + customer registration ---
  /** Show 'expiring soon' badge when active card's expiresAt is ≤ N days away. 0 disables. */
  expiryBadgeThresholdDays: integer('expiry_badge_threshold_days').notNull().default(14),
  /** If true, email is required on the new-customer form (today: optional+recommended). */
  requireEmailOnNewCustomer: boolean('require_email_on_new_customer').notNull().default(false),
  /** If true, at least one child row is required on the new-customer form. */
  requireChildOnNewCustomer: boolean('require_child_on_new_customer').notNull().default(false),

  // --- Cashier anti-fraud controls (Yanay 2026-06-20) ---
  /** If true, every POS sale must record a receipt number from the till. */
  requireReceiptNumberOnPos: boolean('require_receipt_number_on_pos').notNull().default(true),
  /** If true, every POS sale prompts the cashier for their attribution PIN. */
  requireSellerPin: boolean('require_seller_pin').notNull().default(true),
  /** Configurable so we can tighten security later without a migration. */
  pinLength: integer('pin_length').notNull().default(3),
  /** How long the entered PIN is remembered in the device tab between sales. */
  pinMemoryMinutes: integer('pin_memory_minutes').notNull().default(15),
  /** Consecutive wrong PIN tries before the cashier's PIN is locked. */
  pinMaxFailures: integer('pin_max_failures').notNull().default(5),
  /** Lockout duration after pin_max_failures. Manager can unlock earlier. */
  pinLockoutMinutes: integer('pin_lockout_minutes').notNull().default(15),

  // --- Editable customer-facing copy (Yanay can polish from Settings) ---
  /** Label on the mandatory "I wrote the name on the receipt" checkbox at the till. */
  posNameOnReceiptLabel: text('pos_name_on_receipt_label')
    .notNull()
    .default('רשמתי את שם הלקוח על הקבלה במעמד התשלום'),
  /** Helper text under the optional email input on the new-customer form. */
  posEmailNudgeText: text('pos_email_nudge_text')
    .notNull()
    .default(
      'האימייל לא חובה אך מומלץ — מאפשר ללקוח להיכנס לאזור האישי גם אם החליף מספר טלפון או אם ה-SMS לא יגיע.',
    ),
  /** Subject line for the customer email-OTP message. */
  emailOtpSubject: text('email_otp_subject')
    .notNull()
    .default('קוד הכניסה שלך לאזור האישי בממש'),
  /**
   * Body template for the email-OTP message. Placeholders: {{firstName}}
   * (falls back to "לקוח/ה" when missing) and {{code}}. The renderer rejects
   * unknown placeholders at admin-save time so a typo cannot silently break
   * OTPs in production.
   */
  emailOtpBodyTemplate: text('email_otp_body_template')
    .notNull()
    .default(
      'שלום {{firstName}},\n\nקוד הכניסה שלך הוא: {{code}}\n\nהקוד תקף ל-10 דקות.\nאם לא ביקשת קוד זה, אפשר להתעלם מההודעה.\n\nצוות ממש',
    ),

  // --- Checkout-handoff thank-you page on my.memesh.co.il ---
  // After a successful WooCommerce checkout the buyer lands on
  // my.memesh.co.il/checkout-complete and sees a thank-you card with a CTA
  // button to their personal area. The three strings below are the
  // editable copy. Placeholder: {{firstName}} (falls back to "לקוח/ה").
  /** Big headline at the top of the thank-you card. */
  checkoutThankyouTitle: text('checkout_thankyou_title')
    .notNull()
    .default('תודה רבה, {{firstName}}! 🎉'),
  /** Body line under the headline. Same {{firstName}} placeholder. */
  checkoutThankyouBody: text('checkout_thankyou_body')
    .notNull()
    .default('הכרטיסייה שלך מוכנה ומחכה לך באזור האישי. נשמח לראותך אצלנו בקרוב.'),
  /** Text on the CTA button that takes the buyer into the personal area. */
  checkoutThankyouButtonText: text('checkout_thankyou_button_text')
    .notNull()
    .default('לאזור האישי שלי'),

  updatedBy: uuid('updated_by').references(() => staff.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CardSettingsRow = typeof cardSettings.$inferSelect;
export type NewCardSettingsRow = typeof cardSettings.$inferInsert;
