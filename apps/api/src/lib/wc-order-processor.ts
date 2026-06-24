import {
  countCardsForWcOrder,
  createGiftPendingClaim,
  createPunchCard,
  findCustomerByPhoneOrEmail,
  findPendingClaimByOrderId,
  getCardSettings,
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

// WC's meta_data is a flat array of {id,key,value} triples. The gift-card
// flow looks for five specific keys (underscore-prefixed per WC convention).
// Values are strings in practice; we tolerate other JSON-y shapes by ignoring
// non-string values rather than failing the whole payload.
const wcMetaItemSchema = z.object({
  key: z.string(),
  value: z.unknown(),
});

const wcOrderPayloadSchema = z.object({
  id: z.number(),
  status: z.string(),
  customer_id: z.number().nullable().optional(),
  billing: wcBillingSchema,
  line_items: z.array(wcLineItemSchema),
  meta_data: z.array(wcMetaItemSchema).optional(),
});

export type WcOrderPayload = z.infer<typeof wcOrderPayloadSchema>;

// ---------------------------------------------------------------------------
// Gift-card meta extraction
// ---------------------------------------------------------------------------

/**
 * Parsed gift-card meta from a WC order. `null` when the order isn't a gift
 * (no `_memesh_gift` flag, or the flag is anything other than "yes"/"true").
 */
export interface GiftMeta {
  recipientFirstName: string;
  recipientLastName: string;
  recipientPhone: string;
  recipientEmail: string;
}

const GIFT_FLAG_KEYS = new Set(['_memesh_gift']);
const GIFT_FLAG_TRUE = new Set(['yes', 'true', '1', 'on']);

const META_KEYS = {
  recipientFirstName: '_memesh_gift_recipient_first_name',
  recipientLastName: '_memesh_gift_recipient_last_name',
  recipientPhone: '_memesh_gift_recipient_phone',
  recipientEmail: '_memesh_gift_recipient_email',
} as const;

const readMetaString = (
  metaData: WcOrderPayload['meta_data'],
  key: string,
): string => {
  if (!metaData) return '';
  for (const item of metaData) {
    if (item.key !== key) continue;
    if (typeof item.value === 'string') return item.value;
    if (typeof item.value === 'number') return String(item.value);
    return '';
  }
  return '';
};

/**
 * Inspect the order's `meta_data` for the gift-card markers. Returns the
 * recipient details when the `_memesh_gift` flag is set, `null` otherwise.
 * Validation of recipient phone/email shape is done at the processor layer,
 * not here, so the failure-row path can record a precise reason.
 */
export const extractGiftMeta = (payload: WcOrderPayload): GiftMeta | null => {
  if (!payload.meta_data) return null;
  // Find the flag; tolerate either uppercase Yes / TRUE / etc.
  let flagged = false;
  for (const item of payload.meta_data) {
    if (!GIFT_FLAG_KEYS.has(item.key)) continue;
    const v = typeof item.value === 'string' ? item.value.trim().toLowerCase() : '';
    if (GIFT_FLAG_TRUE.has(v)) {
      flagged = true;
      break;
    }
  }
  if (!flagged) return null;
  return {
    recipientFirstName: readMetaString(payload.meta_data, META_KEYS.recipientFirstName).trim(),
    recipientLastName: readMetaString(payload.meta_data, META_KEYS.recipientLastName).trim(),
    recipientPhone: readMetaString(payload.meta_data, META_KEYS.recipientPhone).trim(),
    recipientEmail: readMetaString(payload.meta_data, META_KEYS.recipientEmail).trim(),
  };
};

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
      // Canonical 05XXXXXXXX form (post-normalization). The webhook route uses
      // it to address the post-purchase SMS without re-querying the customer.
      customerPhone: string;
      /** May be null when the customer was created without an email (POS path). */
      customerEmail: string | null;
      /** First name for the email greeting; falls back to "לקוח/ה" downstream when blank. */
      customerFirstName: string;
      customerCreated: boolean;
      cardsCreated: string[];
      // Per-card teaser data for the post-purchase SMS body. Same length and
      // order as `cardsCreated` — i-th entry describes the card whose serial
      // is at `cardsCreated[i]`. Empty when reconciliation got here first
      // and no new cards were created in THIS delivery (the webhook route
      // uses this to suppress duplicate SMS sends).
      cardsSummary: Array<{ totalEntries: number; expiresAt: Date | null }>;
    }
  | {
      // Gift order whose recipient was already a Memesh customer (matched by
      // phone or email). Cards minted directly to the recipient with
      // is_gift=true and the buyer's identity denormalized onto each row.
      status: 'processed_gift_direct';
      orderId: string;
      recipientCustomerId: string;
      recipientCustomerEmail: string | null;
      recipientFirstName: string;
      buyerEmail: string;
      buyerFirstName: string;
      /** Empty on a re-delivery (cards already minted). */
      cardsCreated: string[];
      cardsSummary: Array<{ totalEntries: number; expiresAt: Date | null }>;
      /** 'phone' or 'email' — which signal matched the existing customer. */
      matchedBy: 'phone' | 'email';
      /**
       * When phone matched customer A and email matched a different customer
       * B, this is B's id (phone wins by rule; surfaced so admin can review).
       */
      recipientMatchConflictCustomerId?: string;
    }
  | {
      // Gift order whose recipient is NOT yet a Memesh customer. A
      // gift_pending_claims row holds the gift until the recipient verifies
      // their phone via the claim flow. No customer or card is created on
      // this path.
      status: 'processed_gift_pending';
      orderId: string;
      pendingClaimId: string;
      /**
       * Raw claim token to embed in the recipient's email URL. Undefined on a
       * re-delivery — the route layer must not send a second claim email.
       */
      rawClaimToken?: string;
      /** True if a pending claim already existed (webhook re-delivery). */
      alreadyExisted: boolean;
      recipientFirstName: string;
      recipientEmail: string;
      buyerEmail: string;
      buyerFirstName: string;
      /** Teaser of what the recipient will receive on claim — for the email body. */
      cardSummary: { totalEntries: number; validityDays: number | null };
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

    // ----- Gift branch (added 2026-06-24) -----
    // We read settings once per webhook delivery. When `giftCardsEnabled` is
    // off, gift meta is ignored entirely and the order flows through the
    // normal buyer-attribution path below. This is the ops kill-switch.
    const settings = await getCardSettings(tx);
    const giftMeta = settings.giftCardsEnabled ? extractGiftMeta(order) : null;
    if (giftMeta) {
      // Buyer first/last for denormalizing onto the gift_pending_claims row
      // and gift_buyer_* columns on the punch card. Same fallback semantics
      // the non-gift path uses below.
      const buyerFirstName = order.billing?.first_name?.trim() || 'WooCommerce';
      const buyerLastName = order.billing?.last_name?.trim() || 'Customer';
      const buyerPhone = phoneParsed.data;
      const buyerEmail = rawEmail;

      // Recipient phone must normalize to a canonical Israeli mobile — same
      // validator the buyer phone went through above. Without this we cannot
      // do the recipient lookup nor verify the recipient via OTP at claim.
      const recipientPhoneParsed = phoneSchema.safeParse(giftMeta.recipientPhone);
      if (!recipientPhoneParsed.success) {
        await recordWcWebhookFailure(tx, {
          deliveryId: input.deliveryId,
          wcOrderId: orderIdStr,
          reason: 'gift_recipient_phone_invalid',
          payload: input.payload,
        });
        return {
          status: 'failure',
          reason: 'gift_recipient_phone_invalid',
          orderId: orderIdStr,
        };
      }
      if (giftMeta.recipientEmail.length === 0) {
        await recordWcWebhookFailure(tx, {
          deliveryId: input.deliveryId,
          wcOrderId: orderIdStr,
          reason: 'gift_recipient_email_missing',
          payload: input.payload,
        });
        return {
          status: 'failure',
          reason: 'gift_recipient_email_missing',
          orderId: orderIdStr,
        };
      }
      if (giftMeta.recipientFirstName.length === 0) {
        await recordWcWebhookFailure(tx, {
          deliveryId: input.deliveryId,
          wcOrderId: orderIdStr,
          reason: 'gift_recipient_first_name_missing',
          payload: input.payload,
        });
        return {
          status: 'failure',
          reason: 'gift_recipient_first_name_missing',
          orderId: orderIdStr,
        };
      }

      const recipientPhone = recipientPhoneParsed.data;
      const recipientEmail = giftMeta.recipientEmail;
      // Last name is allowed to be empty — Hebrew first-names alone are
      // common in personal gifting. Store as empty string if absent so the
      // not-null column constraint is satisfied.
      const recipientLastName = giftMeta.recipientLastName;

      // Card spec for the recipient email + pending-claim row. Gift orders
      // are restricted to "one gift per order" by the WC plugin, so we take
      // the first matched line item's config.
      const firstMatched = matched[0]!;
      const cardSummaryTeaser = {
        totalEntries: firstMatched.totalEntries,
        validityDays: firstMatched.validityDays,
      };

      // Does the recipient already exist as a Memesh customer?
      const lookup = await findCustomerByPhoneOrEmail(tx, {
        phone: recipientPhone,
        email: recipientEmail,
      });

      if (lookup.found) {
        // ----- Direct-mint branch -----
        // Same reconciliation-safe pattern the non-gift path uses; cards
        // already on this WC order (from a prior delivery or the cron)
        // short-circuit the loop.
        const totalNeeded = matched.reduce((sum, m) => sum + m.quantity, 0);
        const existingCount = await countCardsForWcOrder(tx, orderIdStr);
        let remaining = Math.max(0, totalNeeded - existingCount);
        const giftClaimedAt = input.now ?? new Date();

        const serials: string[] = [];
        const cardsSummary: Array<{ totalEntries: number; expiresAt: Date | null }> = [];
        outer: for (const m of matched) {
          for (let i = 0; i < m.quantity; i += 1) {
            if (remaining <= 0) break outer;
            const card = await createPunchCard(tx, input.resolver, {
              customerId: lookup.customer.id,
              totalEntries: m.totalEntries,
              validityDays: m.validityDays,
              source: 'online',
              wcOrderId: orderIdStr,
              gift: {
                buyerFirstName,
                buyerLastName,
                buyerPhone,
                claimedAt: giftClaimedAt,
              },
              ...(input.now && { now: input.now }),
            });
            serials.push(card.serialNumber);
            cardsSummary.push({
              totalEntries: card.totalEntries,
              expiresAt: card.expiresAt,
            });
            remaining -= 1;
          }
        }

        return {
          status: 'processed_gift_direct',
          orderId: orderIdStr,
          recipientCustomerId: lookup.customer.id,
          recipientCustomerEmail: lookup.customer.email ?? null,
          recipientFirstName: lookup.customer.firstName || giftMeta.recipientFirstName,
          buyerEmail,
          buyerFirstName,
          cardsCreated: serials,
          cardsSummary,
          matchedBy: lookup.matchedBy,
          ...(lookup.conflictWithEmailMatchCustomerId !== undefined && {
            recipientMatchConflictCustomerId: lookup.conflictWithEmailMatchCustomerId,
          }),
        };
      }

      // ----- Pending-claim branch -----
      // Reconciliation idempotency: re-delivery of the same gift order must
      // not create a second pending row. The advisory lock above serializes
      // concurrent webhook + cron paths so this check is race-safe.
      const existingPending = await findPendingClaimByOrderId(tx, orderIdStr);
      if (existingPending) {
        return {
          status: 'processed_gift_pending',
          orderId: orderIdStr,
          pendingClaimId: existingPending.id,
          alreadyExisted: true,
          recipientFirstName: existingPending.recipientFirstName,
          recipientEmail: existingPending.recipientEmail,
          buyerEmail: existingPending.buyerEmail,
          buyerFirstName: existingPending.buyerFirstName,
          cardSummary: cardSummaryTeaser,
        };
      }

      const created = await createGiftPendingClaim(tx, {
        wcOrderId: orderIdStr,
        wcSku: firstMatched.sku,
        buyerFirstName,
        buyerLastName,
        buyerEmail,
        buyerPhone,
        recipientFirstName: giftMeta.recipientFirstName,
        recipientLastName,
        recipientEmail,
        recipientPhone,
        ttlDays: settings.giftClaimTtlDays,
        ...(input.now && { now: input.now }),
      });

      return {
        status: 'processed_gift_pending',
        orderId: orderIdStr,
        pendingClaimId: created.row.id,
        rawClaimToken: created.rawClaimToken,
        alreadyExisted: false,
        recipientFirstName: giftMeta.recipientFirstName,
        recipientEmail,
        buyerEmail,
        buyerFirstName,
        cardSummary: cardSummaryTeaser,
      };
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
    const cardsSummary: Array<{ totalEntries: number; expiresAt: Date | null }> = [];
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
        cardsSummary.push({
          totalEntries: card.totalEntries,
          expiresAt: card.expiresAt,
        });
        remaining -= 1;
      }
    }

    return {
      status: 'processed',
      orderId: orderIdStr,
      customerId: customer.id,
      customerPhone: customer.phone,
      customerEmail: customer.email ?? null,
      customerFirstName: customer.firstName,
      customerCreated: created,
      cardsCreated: serials,
      cardsSummary,
    };
  });
};
