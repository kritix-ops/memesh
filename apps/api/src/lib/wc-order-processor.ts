import {
  countCardsForWcOrder,
  createPunchCard,
  getWcProductCardConfig,
  markWcWebhookProcessed,
  recordWcWebhookFailure,
  resolveOrCreateCustomerFromWc,
} from '@memesh/db';
import type { KeyResolver } from '@memesh/qr-engine';
import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { phoneSchema } from './phone-schema.js';

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
type AnyPgDatabase = PgDatabase<any, any, any>;

// ---------------------------------------------------------------------------
// WC payload shape (the subset we care about)
// ---------------------------------------------------------------------------

// WooCommerce sends a verbose order JSON. We validate and extract only the
// fields the integration uses; anything else is ignored so the shape can drift
// without breaking us. `id` is always a number; `wc_order_id` in our schema is
// a varchar, so we string-coerce at the boundary.
const wcLineItemSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  product_id: z.number().optional(),
  sku: z.string().nullable().optional(),
  quantity: z.number().int().positive(),
});

const wcBillingSchema = z
  .object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  })
  .optional();

const wcOrderPayloadSchema = z.object({
  id: z.number(),
  status: z.string(),
  customer_id: z.number().nullable().optional(),
  billing: wcBillingSchema,
  line_items: z.array(wcLineItemSchema),
});

export type WcOrderPayload = z.infer<typeof wcOrderPayloadSchema>;

// ---------------------------------------------------------------------------
// Input + result types
// ---------------------------------------------------------------------------

export interface ProcessWcOrderWebhookInput {
  /** Value of the `X-WC-Webhook-Delivery-ID` header. Idempotency key. */
  deliveryId: string;
  /** Value of the `X-WC-Webhook-Topic` header — e.g. `order.updated`. */
  topic: string;
  /** Already-JSON-parsed body. The processor validates it. */
  payload: unknown;
  /** QR signing resolver. Tests pass a fake; the route passes `envKeyResolver`. */
  resolver: KeyResolver;
  /**
   * Did the customer tick a marketing-consent checkbox on the WC checkout?
   * Defaults to false. If WC starts surfacing a consent field we can read it
   * from the payload's meta_data and pass it in here.
   */
  marketingConsent?: boolean;
  /** Override `now` for tests. */
  now?: Date;
}

export type ProcessWcOrderWebhookResult =
  | { status: 'duplicate'; deliveryId: string }
  | { status: 'invalid_payload'; issues: z.ZodIssue[] }
  | { status: 'ignored_topic'; topic: string }
  | { status: 'ignored_status'; orderStatus: string }
  | { status: 'no_matching_skus'; orderId: string }
  | { status: 'failure'; reason: string; orderId?: string }
  | {
      status: 'processed';
      orderId: string;
      customerId: string;
      customerCreated: boolean;
      cardsCreated: string[];
    };

// Topics we react to. `order.created` covers gateways that mint orders
// already in 'completed' status; `order.updated` covers redirect-to-pay
// gateways that move the status to 'completed' on return.
const RELEVANT_TOPICS = new Set(['order.created', 'order.updated']);

// Order statuses we treat as "paid and ready" for card minting.
//   - 'completed': fulfilled (the default for virtual/downloadable products)
//   - 'processing': payment received, awaiting fulfillment (the default for
//     physical products and for most gateway redirects). For a punch card
//     there's nothing to fulfill — the payment IS the fulfillment — so
//     'processing' counts the same as 'completed' for our purposes.
// Anything else (pending / on-hold / failed / cancelled / refunded) we
// intentionally ignore: the card shouldn't exist until the customer paid.
const PAID_STATUSES = new Set(['completed', 'processing']);

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process a single WooCommerce order webhook delivery.
 *
 * Side effects (all inside one transaction, serialized per-order by a
 * Postgres advisory lock):
 *  - Records the delivery id in `wc_processed_webhooks` (idempotency).
 *  - Resolves or creates a customer from `billing.phone` (via the
 *    `resolveOrCreateCustomerFromWc` repository function).
 *  - Creates one `punch_cards` row per (line-item × quantity), capped at the
 *    total still missing so reconciliation can safely re-run this code.
 *  - Records a failure row when something is wrong with the payload (phone
 *    missing, etc.) so an admin sees it instead of the webhook silently
 *    succeeding with no cards created.
 *
 * Returns a discriminated result the caller maps to a log + HTTP status.
 */
export const processWcOrderWebhook = async (
  db: AnyPgDatabase,
  input: ProcessWcOrderWebhookInput,
): Promise<ProcessWcOrderWebhookResult> => {
  if (!RELEVANT_TOPICS.has(input.topic)) {
    return { status: 'ignored_topic', topic: input.topic };
  }

  const parsed = wcOrderPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    await recordWcWebhookFailure(db, {
      deliveryId: input.deliveryId,
      wcOrderId: null,
      reason: 'invalid_payload',
      payload: input.payload,
    });
    return { status: 'invalid_payload', issues: parsed.error.issues };
  }
  const order = parsed.data;

  if (!PAID_STATUSES.has(order.status)) {
    return { status: 'ignored_status', orderStatus: order.status };
  }

  const orderIdStr = String(order.id);

  return db.transaction(async (tx) => {
    // Serialize this WC order across webhook + reconciliation paths.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`wc_order:${orderIdStr}`}))`,
    );

    // Claim the delivery id — second delivery of the same id short-circuits.
    const mark = await markWcWebhookProcessed(tx, {
      deliveryId: input.deliveryId,
      wcOrderId: orderIdStr,
      topic: input.topic,
    });
    if (!mark.inserted) {
      return { status: 'duplicate', deliveryId: input.deliveryId };
    }

    // Map line items → card configs. Unknown SKUs are skipped (logged at the
    // route level so an operator can decide whether to add a config row).
    const matched: Array<{
      sku: string;
      totalEntries: number;
      validityDays: number | null;
      quantity: number;
    }> = [];
    for (const li of order.line_items) {
      if (!li.sku) continue;
      const config = await getWcProductCardConfig(tx, li.sku);
      if (!config) continue;
      matched.push({
        sku: li.sku,
        totalEntries: config.totalEntries,
        validityDays: config.validityDays,
        quantity: li.quantity,
      });
    }
    if (matched.length === 0) {
      return { status: 'no_matching_skus', orderId: orderIdStr };
    }

    // Phone is the customer-join key. WC checkout enforces it as mandatory,
    // but a malformed value can still arrive; surface that as a failure row
    // instead of silently no-op'ing.
    const rawPhone = order.billing?.phone ?? '';
    const phoneParsed = phoneSchema.safeParse(rawPhone);
    if (!phoneParsed.success) {
      await recordWcWebhookFailure(tx, {
        deliveryId: input.deliveryId,
        wcOrderId: orderIdStr,
        reason: 'phone_missing',
        payload: input.payload,
      });
      return { status: 'failure', reason: 'phone_missing', orderId: orderIdStr };
    }

    // Email is required for web orders (Yanay 2026-06-20) — web customers
    // are already online so capturing it is friction-free, and it's what
    // unlocks the email-OTP login fallback when SMS later fails or the
    // customer's phone number changes. Defense-in-depth: WC checkout
    // already requires email by default, but we enforce here so a misconfig
    // upstream surfaces as a clean failure row instead of silently
    // creating a customer with no email on file.
    const rawEmail = order.billing?.email?.trim() ?? '';
    if (!rawEmail) {
      await recordWcWebhookFailure(tx, {
        deliveryId: input.deliveryId,
        wcOrderId: orderIdStr,
        reason: 'email_required',
        payload: input.payload,
      });
      return { status: 'failure', reason: 'email_required', orderId: orderIdStr };
    }

    const wpUserId =
      typeof order.customer_id === 'number' && order.customer_id > 0
        ? order.customer_id
        : null;

    const { customer, created } = await resolveOrCreateCustomerFromWc(tx, {
      phone: phoneParsed.data,
      firstName: order.billing?.first_name?.trim() || 'WooCommerce',
      lastName: order.billing?.last_name?.trim() || 'Customer',
      email: rawEmail,
      wpUserId,
      marketingConsent: input.marketingConsent ?? false,
      ...(input.now && { now: input.now }),
    });

    // Reconciliation-safe card creation: if some cards already exist for this
    // WC order (the cron got here first, or a prior partial run), only create
    // the remaining ones needed to match the order's total quantity.
    const totalNeeded = matched.reduce((sum, m) => sum + m.quantity, 0);
    const existingCount = await countCardsForWcOrder(tx, orderIdStr);
    let remaining = Math.max(0, totalNeeded - existingCount);

    const serials: string[] = [];
    outer: for (const m of matched) {
      for (let i = 0; i < m.quantity; i += 1) {
        if (remaining <= 0) break outer;
        const card = await createPunchCard(tx, input.resolver, {
          customerId: customer.id,
          totalEntries: m.totalEntries,
          validityDays: m.validityDays,
          source: 'online',
          wcOrderId: orderIdStr,
          ...(input.now && { now: input.now }),
        });
        serials.push(card.serialNumber);
        remaining -= 1;
      }
    }

    return {
      status: 'processed',
      orderId: orderIdStr,
      customerId: customer.id,
      customerCreated: created,
      cardsCreated: serials,
    };
  });
};
