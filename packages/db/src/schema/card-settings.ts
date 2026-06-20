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
  minCompanions: integer('min_companions').notNull().default(1),
  maxCompanions: integer('max_companions').notNull().default(4),
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

  updatedBy: uuid('updated_by').references(() => staff.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CardSettingsRow = typeof cardSettings.$inferSelect;
export type NewCardSettingsRow = typeof cardSettings.$inferInsert;
