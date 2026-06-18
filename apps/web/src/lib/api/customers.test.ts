import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createCustomer, getCustomerDetail, searchCustomers } from './customers';

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

test('searchCustomers passes q as a URL search param and unwraps results', async () => {
  stubFetch({
    status: 200,
    body: {
      results: [
        {
          id: 'cust-1',
          customerNumber: 'L-0001',
          firstName: 'Noa',
          lastName: 'Cohen',
          phone: '050-000-0000',
        },
      ],
    },
  });
  const res = await searchCustomers('noa cohen');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.results.length, 1);
    assert.equal(res.data.results[0]?.firstName, 'Noa');
  }
  // URLSearchParams encodes the space as `+`. Make the assertion tolerant.
  assert.ok(lastCall?.url.includes('/customers?q=noa'));
  assert.ok(lastCall?.url.toLowerCase().includes('cohen'));
});

test('searchCustomers forwards an AbortSignal so callers can cancel', async () => {
  stubFetch({ status: 200, body: { results: [] } });
  const controller = new AbortController();
  await searchCustomers('q', { signal: controller.signal });
  assert.equal(lastCall?.init.signal, controller.signal);
});

test('createCustomer POSTs /customers with the input and unwraps the customer', async () => {
  stubFetch({
    status: 201,
    body: {
      customer: {
        id: 'cust-new',
        customerNumber: 'L-0042',
        firstName: 'Noa',
        lastName: 'Cohen',
        phone: '052-3456789',
      },
    },
  });
  const res = await createCustomer({
    firstName: 'Noa',
    lastName: 'Cohen',
    phone: '052-3456789',
    email: 'noa@example.com',
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.customer.customerNumber, 'L-0042');
  }
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(lastCall?.url.endsWith('/customers'));
  assert.equal(
    lastCall?.init.body,
    JSON.stringify({
      firstName: 'Noa',
      lastName: 'Cohen',
      phone: '052-3456789',
      email: 'noa@example.com',
    }),
  );
});

test('createCustomer surfaces 409 phone_taken as the error code', async () => {
  stubFetch({ status: 409, body: { error: 'phone_taken' } });
  const res = await createCustomer({
    firstName: 'X',
    lastName: 'Y',
    phone: '052-3456789',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 409);
    assert.equal(res.error, 'phone_taken');
  }
});

test('getCustomerDetail builds the /:id path and unwraps the detail envelope', async () => {
  stubFetch({
    status: 200,
    body: {
      customer: {
        id: 'cust-1',
        customerNumber: 'L-0001',
        firstName: 'Noa',
        lastName: 'Cohen',
        children: [],
      },
      cards: [],
      entries: [],
    },
  });
  const res = await getCustomerDetail('cust-1');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.customer.firstName, 'Noa');
    assert.equal(res.data.cards.length, 0);
  }
  assert.ok(lastCall?.url.endsWith('/customers/cust-1'));
});
