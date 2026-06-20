import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { getDashboardStats, getDormantCustomers, listStaffActions } from './admin';

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

test('getDashboardStats fetches /admin/dashboard and unwraps stats', async () => {
  stubFetch({
    status: 200,
    body: {
      stats: {
        entriesLast24h: 12,
        entriesLast7d: 80,
        entriesLast30d: 320,
        cardsSoldLast30d: 26,
        expiringIn30d: 4,
        newCustomersLast7d: 9,
      },
    },
  });
  const res = await getDashboardStats();
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.stats.entriesLast24h, 12);
    assert.equal(res.data.stats.cardsSoldLast30d, 26);
  }
  assert.ok(lastCall?.url.endsWith('/admin/dashboard'));
});

test('getDormantCustomers fetches /admin/reports/dormant and unwraps the list', async () => {
  stubFetch({
    status: 200,
    body: {
      customers: [
        {
          id: 'c1',
          customerNumber: 'L-0001',
          firstName: 'Noa',
          lastName: 'Cohen',
          phone: '052-3456789',
          lastVisit: null,
        },
      ],
    },
  });
  const res = await getDormantCustomers();
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.customers.length, 1);
    assert.equal(res.data.customers[0]?.customerNumber, 'L-0001');
  }
  assert.ok(lastCall?.url.endsWith('/admin/reports/dormant'));
});

test('listStaffActions fetches /admin/actions and unwraps the actions', async () => {
  stubFetch({
    status: 200,
    body: {
      actions: [
        {
          id: 'a1',
          action: 'sell_card',
          summary: 'Sold card to Noa Cohen',
          createdAt: '2026-06-18T10:00:00.000Z',
          staffId: 's1',
          staffFirstName: 'Maya',
          staffLastName: 'Barak',
        },
      ],
    },
  });
  const res = await listStaffActions();
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.actions.length, 1);
    assert.equal(res.data.actions[0]?.action, 'sell_card');
  }
  assert.ok(lastCall?.url.endsWith('/admin/actions'));
});
