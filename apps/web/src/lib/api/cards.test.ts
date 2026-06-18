import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { cancelCardForAdmin, listCardsForAdmin, sellCard } from './cards';

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

test('listCardsForAdmin builds /cards?status=... and unwraps the cards', async () => {
  stubFetch({
    status: 200,
    body: {
      cards: [
        {
          id: 'card-1',
          customerId: 'cust-1',
          serialNumber: 'M-20260618-0001',
          totalEntries: 12,
          usedEntries: 3,
          isActive: true,
          expiresAt: '2027-06-18T00:00:00.000Z',
          cancelledAt: null,
          cancelReason: null,
          source: 'pos',
          createdAt: '2026-06-18T10:00:00.000Z',
          customerFirstName: 'Noa',
          customerLastName: 'Cohen',
          customerNumber: 'L-0001',
          customerPhone: '052-3456789',
        },
      ],
    },
  });
  const res = await listCardsForAdmin({ status: 'active' });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.cards.length, 1);
    assert.equal(res.data.cards[0]?.customerNumber, 'L-0001');
  }
  assert.ok(lastCall?.url.includes('/cards?status=active'));
});

test('listCardsForAdmin omits the query string when no options are passed', async () => {
  stubFetch({ status: 200, body: { cards: [] } });
  await listCardsForAdmin();
  assert.ok(lastCall?.url.endsWith('/cards'));
});

test('cancelCardForAdmin POSTs /cards/:id/cancel with the reason', async () => {
  stubFetch({
    status: 200,
    body: {
      card: {
        id: 'card-1',
        serialNumber: 'M-20260618-0001',
        isActive: false,
        cancelledAt: '2026-06-18T10:00:00.000Z',
        cancelReason: 'בקשת לקוח',
      },
    },
  });
  const res = await cancelCardForAdmin('card-1', 'בקשת לקוח');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.card.cancelReason, 'בקשת לקוח');
  }
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(lastCall?.url.endsWith('/cards/card-1/cancel'));
  assert.equal(lastCall?.init.body, JSON.stringify({ reason: 'בקשת לקוח' }));
});

test('cancelCardForAdmin surfaces a 404 (already cancelled or missing) cleanly', async () => {
  stubFetch({ status: 404, body: { error: 'not_found' } });
  const res = await cancelCardForAdmin('card-1', 'r');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 404);
    assert.equal(res.error, 'not_found');
  }
});
