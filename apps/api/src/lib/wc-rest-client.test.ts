import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWcRestClient,
  type WcOrderSummary,
} from './wc-rest-client.js';

// Minimal Response-shape stub so we don't need a real Response.
function jsonResponse(
  body: unknown,
  init: { status?: number; totalPages?: number } = {},
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.totalPages !== undefined) headers.set('x-wp-totalpages', String(init.totalPages));
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

function makeOrder(id: number, sku = '1004'): WcOrderSummary {
  return {
    id,
    status: 'completed',
    customer_id: 0,
    billing: { first_name: 'Test', last_name: 'Buyer', phone: '052-000-0000' },
    line_items: [{ id: id * 10, sku, quantity: 1 }],
  };
}

test('listCompletedOrdersSince builds the URL with the correct query params and basic auth', async () => {
  let capturedUrl = '';
  let capturedHeaders: Headers | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = new Headers(init.headers);
    return jsonResponse([], { totalPages: 1 });
  }) as unknown as typeof fetch;

  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck_demo',
    consumerSecret: 'cs_demo',
    fetchImpl,
  });

  const since = new Date('2026-06-18T00:00:00.000Z');
  await client.listCompletedOrdersSince(since);

  assert.match(capturedUrl, /\/wp-json\/wc\/v3\/orders\?/);
  assert.match(capturedUrl, /status=completed/);
  assert.match(capturedUrl, /per_page=100/);
  assert.match(capturedUrl, /page=1/);
  assert.match(capturedUrl, /orderby=date/);
  assert.ok(capturedUrl.includes(encodeURIComponent(since.toISOString())));

  const auth = capturedHeaders?.get('authorization');
  assert.equal(
    auth,
    `Basic ${Buffer.from('ck_demo:cs_demo').toString('base64')}`,
  );
});

test('listCompletedOrdersSince paginates until X-WP-TotalPages is reached', async () => {
  const pages = [
    Array.from({ length: 100 }, (_, i) => makeOrder(i + 1)),
    Array.from({ length: 100 }, (_, i) => makeOrder(i + 101)),
    Array.from({ length: 42 }, (_, i) => makeOrder(i + 201)),
  ];
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    calls += 1;
    const match = /[?&]page=(\d+)/.exec(String(url));
    const page = Number.parseInt(match?.[1] ?? '1', 10);
    return jsonResponse(pages[page - 1] ?? [], { totalPages: 3 });
  }) as unknown as typeof fetch;

  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
  });

  const orders = await client.listCompletedOrdersSince(new Date(0));
  assert.equal(calls, 3);
  assert.equal(orders.length, 242);
  assert.equal(orders[0]?.id, 1);
  assert.equal(orders[241]?.id, 242);
});

test('listCompletedOrdersSince stops on a short page when X-WP-TotalPages is missing', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    // Single short page, no totalPages header (some proxies strip it).
    return jsonResponse([makeOrder(1), makeOrder(2)]);
  }) as unknown as typeof fetch;

  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
  });
  const orders = await client.listCompletedOrdersSince(new Date(0));
  assert.equal(calls, 1);
  assert.equal(orders.length, 2);
});

test('listCompletedOrdersSince throws when WC returns a non-2xx status', async () => {
  const fetchImpl = (async () =>
    new Response('forbidden', { status: 401 })) as unknown as typeof fetch;
  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
  });
  await assert.rejects(
    () => client.listCompletedOrdersSince(new Date(0)),
    /orders fetch failed: 401/,
  );
});

test('listCompletedOrdersSince throws when WC returns a non-array body', async () => {
  const fetchImpl = (async () =>
    jsonResponse({ error: 'oops' })) as unknown as typeof fetch;
  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
  });
  await assert.rejects(
    () => client.listCompletedOrdersSince(new Date(0)),
    /not an array/,
  );
});

test('listCompletedOrdersSince stops at maxPages even if WC reports more pages', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse(
      Array.from({ length: 100 }, (_, i) => makeOrder(calls * 100 + i)),
      { totalPages: 999 },
    );
  }) as unknown as typeof fetch;

  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
    maxPages: 2,
  });
  const orders = await client.listCompletedOrdersSince(new Date(0));
  assert.equal(calls, 2);
  assert.equal(orders.length, 200);
});

test('listCompletedOrdersSince strips a trailing slash from baseUrl', async () => {
  let capturedUrl = '';
  const fetchImpl = (async (url: string) => {
    capturedUrl = String(url);
    return jsonResponse([], { totalPages: 1 });
  }) as unknown as typeof fetch;
  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3/',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
  });
  await client.listCompletedOrdersSince(new Date(0));
  // No double slash before /orders.
  assert.match(capturedUrl, /\.co\.il\/wp-json\/wc\/v3\/orders\?/);
  assert.doesNotMatch(capturedUrl, /v3\/\/orders/);
});

// ---------------------------------------------------------------------------
// createOrder / getOrder — the companion-upsell checkout
// ---------------------------------------------------------------------------

test('createOrder POSTs a pending order with fee lines + meta and returns the order key', async () => {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return jsonResponse({ id: 901, status: 'pending', order_key: 'wc_order_abc' }, { status: 201 });
  }) as unknown as typeof fetch;

  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
  });
  const order = await client.createOrder({
    billing: { first_name: 'נועה', phone: '052-000-0001' },
    fee_lines: [{ name: 'מלווה נוסף', total: '12.00' }],
    meta_data: [{ key: '_memesh_companion_booking_id', value: 'b-1' }],
  });

  assert.match(capturedUrl, /\/wp-json\/wc\/v3\/orders$/);
  assert.equal(capturedBody.status, 'pending');
  assert.deepEqual(capturedBody.fee_lines, [{ name: 'מלווה נוסף', total: '12.00' }]);
  assert.deepEqual(capturedBody.meta_data, [{ key: '_memesh_companion_booking_id', value: 'b-1' }]);
  assert.equal(order.id, 901);
  assert.equal(order.orderKey, 'wc_order_abc');
});

test('createOrder throws on a non-2xx response', async () => {
  const fetchImpl = (async () => jsonResponse({ message: 'nope' }, { status: 401 })) as unknown as typeof fetch;
  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
  });
  await assert.rejects(
    () =>
      client.createOrder({
        billing: { first_name: 'x', phone: '052' },
        fee_lines: [],
        meta_data: [],
      }),
    /order create failed: 401/,
  );
});

test('getOrder fetches status + order key by id', async () => {
  let capturedUrl = '';
  const fetchImpl = (async (url: string) => {
    capturedUrl = String(url);
    return jsonResponse({ id: 902, status: 'processing', order_key: 'wc_order_xyz' });
  }) as unknown as typeof fetch;
  const client = createWcRestClient({
    baseUrl: 'https://memesh.co.il/wp-json/wc/v3',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    fetchImpl,
  });
  const order = await client.getOrder('902');
  assert.match(capturedUrl, /\/orders\/902$/);
  assert.equal(order.status, 'processing');
  assert.equal(order.orderKey, 'wc_order_xyz');
});
