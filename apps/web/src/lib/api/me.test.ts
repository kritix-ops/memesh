import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { getMe, getMyCards, updateMe } from './me';

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

test('getMe fetches /me and unwraps the profile', async () => {
  stubFetch({
    status: 200,
    body: {
      profile: {
        id: 'cust-1',
        customerNumber: 'L-0001',
        firstName: 'Noa',
        lastName: 'Cohen',
        phone: '052-3456789',
        email: null,
        preferredChannel: 'sms',
        children: [],
      },
    },
  });
  const res = await getMe();
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.profile.firstName, 'Noa');
    assert.equal(res.data.profile.preferredChannel, 'sms');
  }
  assert.ok(lastCall?.url.endsWith('/me'));
  assert.equal(lastCall?.init.method ?? 'GET', 'GET');
});

test('getMyCards fetches /me/cards and unwraps the array', async () => {
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
        },
      ],
    },
  });
  const res = await getMyCards();
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.cards.length, 1);
    assert.equal(res.data.cards[0]?.serialNumber, 'M-20260618-0001');
  }
  assert.ok(lastCall?.url.endsWith('/me/cards'));
});

test('updateMe PATCHes /me with the patch body', async () => {
  stubFetch({
    status: 200,
    body: {
      profile: {
        id: 'cust-1',
        customerNumber: 'L-0001',
        firstName: 'Noa',
        lastName: 'Cohen',
        phone: '052-3456789',
        email: 'noa@example.com',
        preferredChannel: 'whatsapp',
        children: [],
      },
    },
  });
  const res = await updateMe({ email: 'noa@example.com', preferredChannel: 'whatsapp' });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.profile.email, 'noa@example.com');
    assert.equal(res.data.profile.preferredChannel, 'whatsapp');
  }
  assert.equal(lastCall?.init.method, 'PATCH');
  assert.ok(lastCall?.url.endsWith('/me'));
  assert.equal(
    lastCall?.init.body,
    JSON.stringify({ email: 'noa@example.com', preferredChannel: 'whatsapp' }),
  );
});
