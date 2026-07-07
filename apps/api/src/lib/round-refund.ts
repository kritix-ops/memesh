import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';
import { createWcRestClient } from './wc-rest-client.js';

// The fail-closed refund dependency for round cancellations, shared by the
// customer cancel route and the admin removal route so the money path has one
// definition. Built once — null when WooCommerce isn't configured, in which
// case a real paid booking can't be refunded and cancel fails closed (the seat
// is never released without confirmed money back).

const wcClient =
  env.WC_API_URL && env.WC_API_CONSUMER_KEY && env.WC_API_CONSUMER_SECRET
    ? createWcRestClient({
        baseUrl: env.WC_API_URL,
        consumerKey: env.WC_API_CONSUMER_KEY,
        consumerSecret: env.WC_API_CONSUMER_SECRET,
      })
    : null;

/**
 * Build the `refund(wcOrderId, amountIls) => Promise<boolean>` dep for
 * cancelBooking. Returns true ONLY when the refund is confirmed. Dev-pay
 * bookings (`dev-*` order ids) have no real WC order, so their refund is a
 * no-op success outside production to keep cancel testable end to end.
 */
export const makeRoundRefund =
  (log: FastifyBaseLogger) =>
  async (wcOrderId: string, amountIls: number): Promise<boolean> => {
    if (wcOrderId.startsWith('dev-')) return env.NODE_ENV !== 'production';
    if (!wcClient) {
      log.error({ wcOrderId }, '[round refund] WC not configured — cannot refund');
      return false;
    }
    try {
      const r = await wcClient.createOrderRefund(wcOrderId, amountIls);
      log.info({ wcOrderId, refundId: r.id, amount: r.amount }, '[round refund] refunded');
      return true;
    } catch (err) {
      log.error({ err, wcOrderId }, '[round refund] refund failed');
      return false;
    }
  };
