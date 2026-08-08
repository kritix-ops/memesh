import { z } from 'zod';

// Heal WooCommerce orders that PayPlus charged but never marked as paid.
//
// The PayPlus plugin's server-to-server callback intermittently saves its full
// transaction meta on the order (approved Charge, transaction uid, voucher) yet
// fails to call payment-complete. The order stays `pending`, WC's unpaid-order
// time limit later auto-cancels it, and the customer ends up charged with a
// cancellation email, no confirmation, and no booking (order 6051, 2026-08-07;
// 16 such orders between the PayPlus go-live on 17/07 and 08/08).
//
// Both the live order webhook and the reconciliation crons only act on
// `processing`/`completed`, so these orders are invisible to every existing
// safety net. This module closes that gap from the WC side alone: the plugin's
// callback meta is itself proof of the charge, so no PayPlus API access is
// needed. A victim order is flipped to `processing` with `set_paid`, and from
// there every existing path takes over — WC sends the customer the normal
// order-processing email, WC's own `order.updated` webhook fires, and the
// round/card processors mint as with any paid order (SSOT: no mint or email
// logic re-implemented here).

const HEAL_STATUSES = ['pending', 'cancelled'] as const;
export type HealableStatus = (typeof HEAL_STATUSES)[number];

// Don't touch a pending order the plugin (or the customer's thank-you
// redirect) might still be completing. Callback meta lands seconds after the
// charge, so 5 minutes of stillness is far past any legitimate in-flight
// completion — while WC's unpaid time limit (~60 min) is still a long way off.
const PENDING_GRACE_MS = 5 * 60 * 1000;

const metaItemSchema = z.object({ key: z.string(), value: z.unknown() });
const orderSchema = z.object({
  id: z.number(),
  status: z.string(),
  total: z.string().optional(),
  date_paid: z.string().nullish(),
  /** UTC per WC; the API host is UTC, so never parse the site-local twin. */
  date_modified_gmt: z.string().nullish(),
  meta_data: z.array(metaItemSchema).optional(),
  refunds: z.array(z.unknown()).optional(),
});

const readMetaString = (
  meta: Array<{ key: string; value?: unknown }> | undefined,
  key: string,
): string | undefined => {
  if (!meta) return undefined;
  for (const m of meta) {
    if (m.key === key && typeof m.value === 'string') return m.value.trim();
  }
  return undefined;
};

// WC's *_gmt fields are UTC but come without a zone suffix; a bare parse would
// apply the host zone. Returns undefined for missing/invalid input.
const parseWcGmt = (value: string | null | undefined): Date | undefined => {
  if (!value) return undefined;
  const d = new Date(value.endsWith('Z') ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * The charge proof: the PayPlus callback wrote an approved, completed Charge.
 * All four fields are required — `approved`/`000` alone also appears on
 * authorization-only transactions, and a missing uid leaves nothing to stamp
 * as the WC transaction id.
 */
const approvedChargeUid = (
  meta: Array<{ key: string; value?: unknown }> | undefined,
): string | undefined => {
  if (readMetaString(meta, 'payplus_status') !== 'approved') return undefined;
  if (readMetaString(meta, 'payplus_status_code') !== '000') return undefined;
  if (readMetaString(meta, 'payplus_type') !== 'Charge') return undefined;
  const uid = readMetaString(meta, 'payplus_transaction_uid');
  return uid ? uid : undefined;
};

export interface HealChargedUnpaidDeps {
  /**
   * Fetch every WC order in `status` created since `since`, as raw WC order
   * objects (the list endpoint returns full payloads including meta_data).
   */
  listOrdersByStatusSince: (status: HealableStatus, since: Date) => Promise<unknown[]>;
  /**
   * Flip an order to paid: `PUT /orders/{id}` with `status: 'processing'`,
   * `set_paid: true` and the PayPlus uid as `transaction_id`. Throws on
   * failure.
   */
  markOrderPaid: (orderId: number, transactionUid: string) => Promise<void>;
}

export interface HealChargedUnpaidOptions {
  lookbackHours: number;
  /** Override `now` for tests. */
  now?: Date;
}

export interface HealChargedUnpaidResult {
  ordersScanned: number;
  /** Orders flipped to paid on this pass. The operator-visibility payload. */
  healed: Array<{ orderId: number; status: string; totalIls: string; transactionUid: string }>;
  /** Charged pending orders left alone because they changed too recently. */
  skippedPendingGrace: number;
  /** Victims whose heal write failed — logged and retried next run. */
  failed: Array<{ orderId: number; error: string }>;
  lookbackHours: number;
}

/**
 * Detect and heal charged-but-unpaid orders. Idempotent: a healed order gains
 * `date_paid` and leaves the pending/cancelled sets, so re-running every
 * minute is safe; a partially-failed write is simply retried next tick.
 * Refund-carrying orders are skipped — never resurrect an order that was
 * already made whole.
 */
export const healChargedUnpaidOrders = async (
  deps: HealChargedUnpaidDeps,
  opts: HealChargedUnpaidOptions,
): Promise<HealChargedUnpaidResult> => {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.lookbackHours * 60 * 60 * 1000);

  let ordersScanned = 0;
  const healed: HealChargedUnpaidResult['healed'] = [];
  const failed: HealChargedUnpaidResult['failed'] = [];
  let skippedPendingGrace = 0;

  for (const status of HEAL_STATUSES) {
    const orders = await deps.listOrdersByStatusSince(status, since);
    ordersScanned += orders.length;

    for (const raw of orders) {
      const parsed = orderSchema.safeParse(raw);
      if (!parsed.success) continue;
      const order = parsed.data;

      if (order.date_paid) continue;
      if (order.refunds && order.refunds.length > 0) continue;
      const transactionUid = approvedChargeUid(order.meta_data);
      if (!transactionUid) continue;

      if (order.status === 'pending') {
        const modified = parseWcGmt(order.date_modified_gmt);
        // An unparseable timestamp shouldn't strand a proven charge — only a
        // genuinely fresh modification defers the heal.
        if (modified && now.getTime() - modified.getTime() < PENDING_GRACE_MS) {
          skippedPendingGrace += 1;
          continue;
        }
      }

      try {
        await deps.markOrderPaid(order.id, transactionUid);
        healed.push({
          orderId: order.id,
          status: order.status,
          totalIls: order.total ?? '',
          transactionUid,
        });
      } catch (err) {
        failed.push({ orderId: order.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { ordersScanned, healed, skippedPendingGrace, failed, lookbackHours: opts.lookbackHours };
};
