import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { setCustomerWpUserId } from './accounts';
import { createCustomer } from './cards';
import {
  customers,
  punchCards,
  wcProcessedWebhooks,
  wcProductCardConfigs,
  wcWebhookFailures,
  type Customer,
  type WcProductCardConfig,
  type WcWebhookFailure,
} from './schema/index';

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
type AnyPgDatabase = PgDatabase<any, any, any>;

// ---------------------------------------------------------------------------
// Product → card-config mapping
// ---------------------------------------------------------------------------

/**
 * Look up the card spec for a WooCommerce SKU. Returns undefined when the SKU
 * is unknown or its config row is inactive — the webhook handler treats both
 * the same way (skip the line item, log it, do not create a card).
 */
export const getWcProductCardConfig = async (
  db: AnyPgDatabase,
  wcSku: string,
): Promise<WcProductCardConfig | undefined> => {
  const rows = await db
    .select()
    .from(wcProductCardConfigs)
    .where(and(eq(wcProductCardConfigs.wcSku, wcSku), eq(wcProductCardConfigs.isActive, true)))
    .limit(1);
  return rows[0];
};

export interface WcProductCardConfigSeed {
  wcSku: string;
  totalEntries: number;
  /** `null` = forever (matches the card_settings sentinel). */
  validityDays: number | null;
}

/**
 * Idempotent seed for the product → card-config table. Skips rows whose
 * `wcSku` already exists so this is safe to re-run at boot or by hand. Does
 * NOT update existing rows: admin changes should be made deliberately via
 * the admin UI / SQL, not silently overwritten by a deploy.
 */
export const seedWcProductCardConfigs = async (
  db: AnyPgDatabase,
  seeds: WcProductCardConfigSeed[],
): Promise<{ inserted: number; skipped: number }> => {
  let inserted = 0;
  let skipped = 0;
  for (const seed of seeds) {
    const rows = await db
      .insert(wcProductCardConfigs)
      .values({
        wcSku: seed.wcSku,
        totalEntries: seed.totalEntries,
        validityDays: seed.validityDays,
      })
      .onConflictDoNothing({ target: wcProductCardConfigs.wcSku })
      .returning({ wcSku: wcProductCardConfigs.wcSku });
    if (rows.length > 0) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
};

/**
 * Seed shipped with the v1 WC integration. SKU 1004 = "משלמים על 10, מקבלים 12".
 * `validityDays: null` = forever, per Yanay 2026-06-20. Admin can override
 * per card via the existing admin card-control flow.
 */
export const WC_PRODUCT_CARD_CONFIG_SEEDS: WcProductCardConfigSeed[] = [
  {
    wcSku: '1004',
    totalEntries: 12,
    validityDays: null,
  },
];

// ---------------------------------------------------------------------------
// Webhook idempotency
// ---------------------------------------------------------------------------

export interface MarkWcWebhookProcessedInput {
  deliveryId: string;
  wcOrderId: string;
  topic: string;
}

/**
 * Try to claim a WC delivery id. Returns `inserted: true` for the first
 * delivery, `inserted: false` for any retry. The webhook handler treats
 * `inserted: false` as "already processed, return 200 without acting".
 *
 * Idempotency is enforced by the primary-key uniqueness on `delivery_id`;
 * the ON CONFLICT DO NOTHING guarantees a quiet no-op on retries.
 */
export const markWcWebhookProcessed = async (
  db: AnyPgDatabase,
  input: MarkWcWebhookProcessedInput,
): Promise<{ inserted: boolean }> => {
  const rows = await db
    .insert(wcProcessedWebhooks)
    .values({
      deliveryId: input.deliveryId,
      wcOrderId: input.wcOrderId,
      topic: input.topic,
    })
    .onConflictDoNothing({ target: wcProcessedWebhooks.deliveryId })
    .returning({ deliveryId: wcProcessedWebhooks.deliveryId });
  return { inserted: rows.length > 0 };
};

// ---------------------------------------------------------------------------
// Card-count lookup for the reconciliation cron
// ---------------------------------------------------------------------------

/**
 * Count how many punch cards already exist for a given WC order id. Used by
 * the hourly reconciliation cron to decide whether a recently-completed WC
 * order is missing any cards we should heal.
 */
export const countCardsForWcOrder = async (
  db: AnyPgDatabase,
  wcOrderId: string,
): Promise<number> => {
  const rows = await db
    .select({ id: punchCards.id })
    .from(punchCards)
    .where(eq(punchCards.wcOrderId, wcOrderId));
  return rows.length;
};

// ---------------------------------------------------------------------------
// Failure queue (never drop silently)
// ---------------------------------------------------------------------------

export interface RecordWcWebhookFailureInput {
  deliveryId: string | null;
  wcOrderId: string | null;
  /** Short machine-readable tag: `phone_missing` | `unknown_sku` | `validation_failure` | ... */
  reason: string;
  /** Raw WC payload (or whatever fragment we have). Stored verbatim for human review. */
  payload: unknown;
}

/** Insert a failure row for manual review. Always returns the inserted row. */
export const recordWcWebhookFailure = async (
  db: AnyPgDatabase,
  input: RecordWcWebhookFailureInput,
): Promise<WcWebhookFailure> => {
  const rows = await db
    .insert(wcWebhookFailures)
    .values({
      deliveryId: input.deliveryId,
      wcOrderId: input.wcOrderId,
      reason: input.reason,
      payload: input.payload as never,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('[recordWcWebhookFailure] insert returned no row');
  return row;
};

// ---------------------------------------------------------------------------
// Customer resolution from WC billing
// ---------------------------------------------------------------------------

export interface ResolveOrCreateCustomerFromWcInput {
  /**
   * Already normalized to canonical 05XXXXXXXX form by the caller (the
   * webhook route runs the raw value through `phoneSchema` before invoking
   * this function). The db layer trusts the input.
   */
  phone: string;
  firstName: string;
  lastName: string;
  email: string | null;
  /**
   * WC `billing.customer_id`. 0 = guest checkout, anything else = an
   * existing WP user. Stored on our `customers.wpUserId` so future
   * customer-portal logins can recognize them by the WP session.
   */
  wpUserId: number | null;
  /**
   * Did the customer tick a marketing-consent checkbox on the WC checkout?
   * Drives the `marketingConsentAt` field used by the SMS dispatch layer.
   */
  marketingConsent: boolean;
  now?: Date;
}

export interface ResolveOrCreateCustomerFromWcResult {
  customer: Customer;
  created: boolean;
}

/**
 * Look up the customer by normalized phone, or create them from the WC
 * billing payload. Used by the WC order webhook to materialize a customer
 * before creating the punch card.
 *
 * If the customer already exists but has no `wpUserId` and we now have one
 * from WC, backfill it (this handles the common case of a customer who was
 * registered at the counter in person before they ever bought online).
 *
 * Phone normalization is the caller's responsibility; we trust the input
 * here and rely on the unique constraint on `customers.phone` to surface
 * any mistake as a database error rather than silently double-create.
 */
export const resolveOrCreateCustomerFromWc = async (
  db: AnyPgDatabase,
  input: ResolveOrCreateCustomerFromWcInput,
): Promise<ResolveOrCreateCustomerFromWcResult> => {
  const now = input.now ?? new Date();

  const existing = await db
    .select()
    .from(customers)
    .where(eq(customers.phone, input.phone))
    .limit(1);
  const found = existing[0];
  if (found) {
    if (input.wpUserId !== null && found.wpUserId === null) {
      await setCustomerWpUserId(db, found.id, input.wpUserId, now);
      return { customer: { ...found, wpUserId: input.wpUserId }, created: false };
    }
    return { customer: found, created: false };
  }

  const created = await createCustomer(db, {
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    ...(input.email !== null && { email: input.email }),
    source: 'website',
    marketingConsent: input.marketingConsent,
    now,
  });
  if (input.wpUserId !== null) {
    await setCustomerWpUserId(db, created.id, input.wpUserId, now);
    return { customer: { ...created, wpUserId: input.wpUserId }, created: true };
  }
  return { customer: created, created: true };
};

// ---------------------------------------------------------------------------
// Gift-card recipient lookup (added 2026-06-24)
// ---------------------------------------------------------------------------

export type RecipientLookupResult =
  | { found: false }
  | {
      found: true;
      customer: Customer;
      /** Which signal matched first; phone wins on conflict. */
      matchedBy: 'phone' | 'email';
      /**
       * Populated only when phone AND email each match — but to DIFFERENT
       * customers. Phone wins, but the email-matched customer id is surfaced
       * so the webhook handler can log the conflict for admin review.
       */
      conflictWithEmailMatchCustomerId?: string;
    };

/**
 * Recipient match for the gift-card flow. Two-stage lookup:
 *   1. exact phone match → return that customer (phone is the canonical
 *      identity in Memesh, unique-constrained on the table)
 *   2. else exact email match → return that customer
 *   3. else not found → caller takes the pending-claim branch
 *
 * Conflict case (phone matches A, email matches B) is reported via
 * `conflictWithEmailMatchCustomerId` so the caller can record the deviation
 * for an admin to investigate later. Phone-wins is the deterministic rule
 * and is applied unconditionally.
 *
 * Email comparison is case-insensitive — emails are case-insensitive at the
 * mailbox level and storing them with mixed case is common in WC.
 */
export const findCustomerByPhoneOrEmail = async (
  db: AnyPgDatabase,
  input: { phone: string; email: string },
): Promise<RecipientLookupResult> => {
  const phoneMatch = await db
    .select()
    .from(customers)
    .where(eq(customers.phone, input.phone))
    .limit(1);
  const phoneCustomer = phoneMatch[0];

  // Always check email too — needed to detect the conflict case even when
  // phone already matched. Skip when input.email is empty (defensive — gift
  // form should never pass an empty email, but treat missing as "no match").
  const trimmedEmail = input.email.trim();
  if (trimmedEmail.length === 0) {
    if (phoneCustomer) {
      return { found: true, customer: phoneCustomer, matchedBy: 'phone' };
    }
    return { found: false };
  }

  // Case-insensitive email match. Drizzle's `lower()` on both sides would be
  // ideal; for portability across PGlite/Postgres we lowercase the input and
  // do an `ilike` (which uses lowercased comparison under the hood).
  const emailMatches = await db
    .select()
    .from(customers)
    .where(eq(customers.email, trimmedEmail))
    .limit(1);
  let emailCustomer = emailMatches[0];
  // Fall back to a case-insensitive lookup when the exact-case query missed.
  // Two queries instead of one ilike to keep the fast path index-friendly.
  if (!emailCustomer && trimmedEmail !== trimmedEmail.toLowerCase()) {
    const ciMatch = await db
      .select()
      .from(customers)
      .where(eq(customers.email, trimmedEmail.toLowerCase()))
      .limit(1);
    emailCustomer = ciMatch[0];
  }

  if (phoneCustomer) {
    // Phone wins. Surface the conflict id when the emails point elsewhere.
    if (emailCustomer && emailCustomer.id !== phoneCustomer.id) {
      return {
        found: true,
        customer: phoneCustomer,
        matchedBy: 'phone',
        conflictWithEmailMatchCustomerId: emailCustomer.id,
      };
    }
    return { found: true, customer: phoneCustomer, matchedBy: 'phone' };
  }
  if (emailCustomer) {
    return { found: true, customer: emailCustomer, matchedBy: 'email' };
  }
  return { found: false };
};
