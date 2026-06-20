import type { KeyResolver } from '@memesh/qr-engine';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { processWcOrderWebhook } from './wc-order-processor.js';
import type { WcOrderSummary, WcRestClient } from './wc-rest-client.js';

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
type AnyPgDatabase = PgDatabase<any, any, any>;

export interface ReconcileWcOrdersDeps {
  wcClient: WcRestClient;
  resolver: KeyResolver;
}

export interface ReconcileWcOrdersOptions {
  lookbackHours: number;
  /** Override `now` for tests. */
  now?: Date;
}

export interface ReconcileWcOrdersResult {
  ordersScanned: number;
  cardsHealed: number;
  duplicates: number;
  ignored: number;
  failures: number;
  lookbackHours: number;
}

/**
 * The reconciliation safety net for the WC → API integration.
 *
 * Runs on a Vercel Cron schedule. Pulls every WC order that's been marked
 * `completed` within the lookback window, then for each one calls the same
 * webhook processor used by the live route — with a stable synthetic
 * delivery id (`recon-${orderId}`) so the processor's idempotency primitive
 * skips orders that were already reconciled.
 *
 * Why reuse the processor:
 *  - Same advisory lock keyed on the WC order id, so a racing live webhook
 *    and the cron will serialize cleanly without double-creating cards.
 *  - Same `countCardsForWcOrder` cap, so orders already fully cared for by
 *    the live webhook leave the cron a no-op.
 *  - One place to fix bugs and add features.
 *
 * The cron's failure modes are bounded: if the WC REST client throws, the
 * cron route catches the error, logs `[cron wc-reconcile] api_error`, and
 * returns a 5xx so Vercel records the failure but the next hourly run
 * starts fresh.
 */
export const reconcileWcOrders = async (
  db: AnyPgDatabase,
  deps: ReconcileWcOrdersDeps,
  opts: ReconcileWcOrdersOptions,
): Promise<ReconcileWcOrdersResult> => {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.lookbackHours * 60 * 60 * 1000);

  const orders: WcOrderSummary[] = await deps.wcClient.listCompletedOrdersSince(since);

  let cardsHealed = 0;
  let duplicates = 0;
  let ignored = 0;
  let failures = 0;

  for (const order of orders) {
    const result = await processWcOrderWebhook(db, {
      // Stable, deterministic id so re-runs see the same processed_webhooks
      // row and short-circuit without churning the table.
      deliveryId: `recon-${order.id}`,
      topic: 'order.updated',
      payload: order,
      resolver: deps.resolver,
      // Reconciliation never knows what the customer ticked at checkout. If
      // we missed consent on the original webhook, it stays missed — better
      // than silently flipping it to true after the fact.
      marketingConsent: false,
      ...(opts.now && { now: opts.now }),
    });

    switch (result.status) {
      case 'processed':
        if (result.cardsCreated.length > 0) cardsHealed += 1;
        break;
      case 'duplicate':
        duplicates += 1;
        break;
      case 'ignored_topic':
      case 'ignored_status':
      case 'no_matching_skus':
        ignored += 1;
        break;
      case 'invalid_payload':
      case 'failure':
        failures += 1;
        break;
    }
  }

  return {
    ordersScanned: orders.length,
    cardsHealed,
    duplicates,
    ignored,
    failures,
    lookbackHours: opts.lookbackHours,
  };
};
