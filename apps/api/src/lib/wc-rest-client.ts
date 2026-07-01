// Thin client for the WooCommerce REST API. Used only by the reconciliation
// cron to fetch completed orders for the last N hours. Read-only.
//
// Auth: HTTP Basic over HTTPS with consumer_key as username and
// consumer_secret as password. WC requires HTTPS for this auth mode.
//
// Pagination: WC returns one page per call, capped at 100 items via
// `per_page=100`. Page count is returned in the `X-WP-TotalPages` header. We
// paginate until we've drained the result set or hit the safety cap.

export interface WcOrderSummary {
  /** WC numeric order id. */
  id: number;
  /** WC status string — we only care about 'completed'. */
  status: string;
  /** ISO timestamp the order moved to its current status (close enough). */
  date_modified_gmt?: string;
  /** WP user id of the buyer; 0 for guest checkout. */
  customer_id?: number | null;
  billing?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
  line_items: Array<{
    id: number;
    name?: string;
    product_id?: number;
    sku?: string | null;
    quantity: number;
  }>;
}

export interface WcRefundResult {
  /** WC refund id. */
  id: number;
  /** Refunded amount as WC returns it (a decimal string). */
  amount: string;
}

export interface WcCreateOrderInput {
  billing: {
    first_name: string;
    last_name?: string;
    phone: string;
    email?: string;
  };
  /** Fee lines instead of product line items — no WP-side product required. */
  fee_lines: Array<{ name: string; total: string }>;
  /** Order-level meta (e.g. the booking id the paid-order webhook resolves). */
  meta_data: Array<{ key: string; value: string }>;
}

export interface WcOrderRef {
  id: number;
  /** WC status string ('pending', 'processing', 'completed', 'cancelled', …). */
  status: string;
  /** The order key needed to build the customer-facing order-pay URL. */
  orderKey: string;
}

export interface WcRestClient {
  /**
   * Fetch every completed order updated after the given timestamp. Paginates
   * until exhausted. Throws on auth failure or non-2xx HTTP — the caller
   * (the cron route) catches and returns 503 so Vercel does not retry an
   * unauthenticated cron forever.
   */
  listCompletedOrdersSince(since: Date): Promise<WcOrderSummary[]>;

  /**
   * Create a refund on an order. `api_refund: true` asks WooCommerce to push the
   * refund to the payment gateway (Meshulam/Grow) — this only actually moves
   * money if the gateway supports programmatic refunds. Throws on non-2xx so the
   * caller can treat "refund not confirmed" as a hard stop (never release a
   * paid seat on an unconfirmed refund).
   */
  createOrderRefund(orderId: string, amountIls: number, reason?: string): Promise<WcRefundResult>;

  /**
   * Create a pending order the customer pays on WC's order-pay page (the
   * punch-booking companion upsell). Throws on non-2xx.
   */
  createOrder(input: WcCreateOrderInput): Promise<WcOrderRef>;

  /** Fetch an order's status + key (retry path of the companion checkout). Throws on non-2xx. */
  getOrder(orderId: string): Promise<WcOrderRef>;
}

export interface WcRestClientConfig {
  /** Base URL like `https://memesh.co.il/wp-json/wc/v3` — no trailing slash. */
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /**
   * Injected for tests so we can run without a real network. Defaults to
   * `globalThis.fetch` (available in Node 18+).
   */
  fetchImpl?: typeof fetch;
  /** Safety cap on pages to fetch. Protects against runaway pagination. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 50; // 50 × 100 orders = 5000 orders per run — plenty for our scale.

export const createWcRestClient = (config: WcRestClientConfig): WcRestClient => {
  const fetcher = config.fetchImpl ?? globalThis.fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const authHeader = `Basic ${Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64')}`;
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;

  return {
    listCompletedOrdersSince: async (since) => {
      const sinceIso = since.toISOString();
      const all: WcOrderSummary[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const url = `${baseUrl}/orders?status=completed&after=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}&orderby=date&order=asc`;
        const res = await fetcher(url, {
          method: 'GET',
          headers: { Authorization: authHeader, Accept: 'application/json' },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(
            `[wc-rest] orders fetch failed: ${res.status} ${text.slice(0, 200)}`,
          );
        }
        const body = (await res.json()) as WcOrderSummary[];
        if (!Array.isArray(body)) {
          throw new Error('[wc-rest] orders response was not an array');
        }
        all.push(...body);

        // Total pages is reported in a response header. If absent (some
        // proxies strip it), stop when we get a short page.
        const totalPagesHeader = res.headers.get('x-wp-totalpages');
        const totalPages = totalPagesHeader ? Number.parseInt(totalPagesHeader, 10) : null;
        if (totalPages !== null && page >= totalPages) break;
        if (body.length < 100) break;
      }
      return all;
    },

    createOrderRefund: async (orderId, amountIls, reason) => {
      const url = `${baseUrl}/orders/${encodeURIComponent(orderId)}/refunds`;
      const res = await fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          amount: amountIls.toFixed(2),
          reason: reason ?? 'Round booking cancelled',
          api_refund: true,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[wc-rest] refund failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as { id: number; amount: string };
      return { id: body.id, amount: body.amount };
    },

    createOrder: async (input) => {
      const url = `${baseUrl}/orders`;
      const res = await fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          status: 'pending',
          billing: input.billing,
          fee_lines: input.fee_lines,
          meta_data: input.meta_data,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[wc-rest] order create failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as { id: number; status: string; order_key: string };
      return { id: body.id, status: body.status, orderKey: body.order_key };
    },

    getOrder: async (orderId) => {
      const url = `${baseUrl}/orders/${encodeURIComponent(orderId)}`;
      const res = await fetcher(url, {
        method: 'GET',
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[wc-rest] order fetch failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as { id: number; status: string; order_key: string };
      return { id: body.id, status: body.status, orderKey: body.order_key };
    },
  };
};
