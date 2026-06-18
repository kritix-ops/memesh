import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import {
  __BASE_URL_FOR_TESTS,
  apiRequest,
  setOnCustomerSessionExpired,
  setOnSessionExpired,
} from './api';

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface StubResponse {
  status: number;
  body?: unknown;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let responseQueue: StubResponse[] = [];

function stubFetch(...responses: StubResponse[]): void {
  responseQueue = [...responses];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responseQueue.shift();
    if (!next) {
      throw new Error(`[test] no more stubbed responses; got ${calls.length} calls`);
    }
    const body = next.body === undefined ? '' : JSON.stringify(next.body);
    return new Response(body, {
      status: next.status,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  responseQueue = [];
  setOnSessionExpired(null);
  setOnCustomerSessionExpired(null);
});

after(() => {
  globalThis.fetch = originalFetch;
  setOnSessionExpired(null);
  setOnCustomerSessionExpired(null);
});

// ---------------------------------------------------------------------------
// Base behavior
// ---------------------------------------------------------------------------

test('BASE_URL is non-empty and defaults to /api in a Node test context', () => {
  assert.ok(__BASE_URL_FOR_TESTS.length > 0);
  assert.equal(__BASE_URL_FOR_TESTS, '/api');
});

test('apiRequest GET returns {ok:true, data} on 200 and sets credentials:include', async () => {
  stubFetch({ status: 200, body: { user: { id: 'u1', role: 'admin' } } });
  const res = await apiRequest<{ user: { id: string; role: string } }>('/auth/me');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.data, { user: { id: 'u1', role: 'admin' } });
  }
  assert.equal(calls[0]?.init.credentials, 'include');
  assert.ok(calls[0]?.url.endsWith('/auth/me'));
});

test('apiRequest POST sends JSON body with Content-Type header', async () => {
  stubFetch({
    status: 200,
    body: { role: 'cashier', accessToken: 'a', refreshToken: 'r' },
  });
  await apiRequest('/auth/login', {
    method: 'POST',
    body: { phone: '050-000-0000', password: 'secret-pw-1234' },
  });
  assert.equal(calls[0]?.init.method, 'POST');
  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  assert.equal(headers?.['Content-Type'], 'application/json');
  assert.equal(
    calls[0]?.init.body,
    JSON.stringify({ phone: '050-000-0000', password: 'secret-pw-1234' }),
  );
});

test('apiRequest returns http_NNN fallback when error body is not JSON', async () => {
  stubFetch({ status: 503 });
  const res = await apiRequest('/health');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 503);
    assert.equal(res.error, 'http_503');
  }
});

test('apiRequest GET does not set Content-Type when there is no body', async () => {
  stubFetch({ status: 200, body: { ok: true } });
  await apiRequest('/auth/me');
  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  assert.equal(headers?.['Content-Type'], undefined);
});

// ---------------------------------------------------------------------------
// Auto-refresh behavior
// ---------------------------------------------------------------------------

test('apiRequest on 401 retries once after a successful /auth/refresh', async () => {
  // Sequence: GET /customers -> 401, POST /auth/refresh -> 200, GET /customers (retry) -> 200
  stubFetch(
    { status: 401, body: { error: 'unauthorized' } },
    { status: 200, body: { ok: true } },
    { status: 200, body: { results: [] } },
  );
  const res = await apiRequest('/customers?q=noa');
  assert.equal(res.ok, true);
  assert.equal(calls.length, 3);
  assert.ok(calls[0]?.url.endsWith('/customers?q=noa'));
  assert.ok(calls[1]?.url.endsWith('/auth/refresh'));
  assert.equal(calls[1]?.init.method, 'POST');
  assert.ok(calls[2]?.url.endsWith('/customers?q=noa'));
});

test('apiRequest on 401 with refresh failure returns 401 and fires onSessionExpired', async () => {
  let expired = 0;
  setOnSessionExpired(() => {
    expired += 1;
  });
  // Sequence: GET /customers -> 401, POST /auth/refresh -> 401
  stubFetch(
    { status: 401, body: { error: 'unauthorized' } },
    { status: 401, body: { error: 'invalid_refresh' } },
  );
  const res = await apiRequest('/customers?q=noa');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
  }
  assert.equal(expired, 1);
  assert.equal(calls.length, 2);
});

test('apiRequest on 401 does NOT auto-refresh /auth/login (skip-list)', async () => {
  stubFetch({ status: 401, body: { error: 'invalid_credentials' } });
  const res = await apiRequest('/auth/login', {
    method: 'POST',
    body: { phone: '050', password: 'wrong' },
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error, 'invalid_credentials');
  }
  // No refresh attempt was made.
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.url.endsWith('/auth/login'));
});

test('apiRequest on 401 does NOT auto-refresh /auth/refresh itself (no infinite loop)', async () => {
  stubFetch({ status: 401, body: { error: 'invalid_refresh' } });
  const res = await apiRequest('/auth/refresh', { method: 'POST' });
  assert.equal(res.ok, false);
  // Only one call — no recursive refresh.
  assert.equal(calls.length, 1);
});

test('apiRequest with audience:customer does NOT auto-refresh on 401', async () => {
  let customerExpired = 0;
  let staffExpired = 0;
  setOnCustomerSessionExpired(() => {
    customerExpired += 1;
  });
  setOnSessionExpired(() => {
    staffExpired += 1;
  });
  stubFetch({ status: 401, body: { error: 'unauthorized' } });
  const res = await apiRequest('/me', { audience: 'customer' });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
  }
  // Only the original call — no refresh attempt.
  assert.equal(calls.length, 1);
  assert.equal(customerExpired, 1);
  assert.equal(staffExpired, 0);
});

test('apiRequest with audience:customer fires customer callback only', async () => {
  let customerExpired = 0;
  let staffExpired = 0;
  setOnCustomerSessionExpired(() => {
    customerExpired += 1;
  });
  setOnSessionExpired(() => {
    staffExpired += 1;
  });
  stubFetch({ status: 200, body: { profile: { id: 'c1', firstName: 'Noa' } } });
  await apiRequest('/me', { audience: 'customer' });
  // A 200 fires nothing.
  assert.equal(customerExpired, 0);
  assert.equal(staffExpired, 0);
});
