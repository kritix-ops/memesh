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
