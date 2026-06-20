import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { customerLogout, requestOtp, verifyOtp } from './customer-auth';

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

test('requestOtp POSTs /auth/customer/request-otp with the phone', async () => {
  stubFetch({ status: 200, body: { ok: true } });
  const res = await requestOtp('052-3456789');
  assert.equal(res.ok, true);
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(lastCall?.url.endsWith('/auth/customer/request-otp'));
  assert.equal(lastCall?.init.body, JSON.stringify({ phone: '052-3456789' }));
});

test('verifyOtp POSTs /auth/customer/verify-otp with phone + code', async () => {
  stubFetch({ status: 200, body: { ok: true, token: 'tok-1' } });
  const res = await verifyOtp('052-3456789', '123456');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.token, 'tok-1');
  }
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(lastCall?.url.endsWith('/auth/customer/verify-otp'));
  assert.equal(lastCall?.init.body, JSON.stringify({ phone: '052-3456789', code: '123456' }));
});

test('verifyOtp returns invalid_code error on 401', async () => {
  stubFetch({ status: 401, body: { ok: false, error: 'invalid_code' } });
  const res = await verifyOtp('052-3456789', '000000');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.error, 'invalid_code');
  }
});

test('customerLogout POSTs /auth/customer/logout', async () => {
  stubFetch({ status: 200, body: { ok: true } });
  const res = await customerLogout();
  assert.equal(res.ok, true);
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(lastCall?.url.endsWith('/auth/customer/logout'));
});
