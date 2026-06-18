import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { sellCard } from './cards';

interface FetchCall {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
let lastCall: FetchCall | null = null;

function stubFetch(response: { status: number; body?: unknown }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    lastCall = { url: String(input), init };
    const body = response.body === undefined ? '' : JSON.stringify(response.body);
    return new Response(body, {
      status: response.status,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    });
  }) as typeof fetch;
}

beforeEach(() => {
  lastCall = null;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('sellCard POSTs /cards with customerId and unwraps the card from the response', async () => {
  stubFetch({
    status: 201,
    body: {
      card: {
        id: 'card-1',
        customerId: 'cust-1',
        serialNumber: 'M-20260618-0001',
        totalEntries: 12,
        usedEntries: 0,
        isActive: true,
      },
    },
  });
  const res = await sellCard({ customerId: 'cust-1' });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.card.serialNumber, 'M-20260618-0001');
    assert.equal(res.data.card.totalEntries, 12);
  }
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(lastCall?.url.endsWith('/cards'));
  assert.equal(lastCall?.init.body, JSON.stringify({ customerId: 'cust-1' }));
});

test('sellCard returns the error union on 400 invalid_body', async () => {
  stubFetch({ status: 400, body: { error: 'invalid_body' } });
  const res = await sellCard({ customerId: 'not-a-uuid' });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 400);
    assert.equal(res.error, 'invalid_body');
  }
});
