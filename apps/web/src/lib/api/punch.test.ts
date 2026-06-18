import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { punchBySerial } from './punch';

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

test('punchBySerial POSTs /punch with serial + companions + idempotency key', async () => {
  stubFetch({
    status: 200,
    body: { ok: true, replay: false, remaining: 5, usedEntries: 7, totalEntries: 12 },
  });
  const res = await punchBySerial('M-20260617-0042', {
    companions: 2,
    idempotencyKey: 'idem-abc',
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.remaining, 5);
    assert.equal(res.data.replay, false);
  }
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(lastCall?.url.endsWith('/punch'));
  assert.equal(
    lastCall?.init.body,
    JSON.stringify({
      serial: 'M-20260617-0042',
      companions: 2,
      idempotencyKey: 'idem-abc',
    }),
  );
});

test('punchBySerial unwraps replay:true on a repeated idempotent call', async () => {
  stubFetch({
    status: 200,
    body: { ok: true, replay: true, remaining: 5, usedEntries: 7, totalEntries: 12 },
  });
  const res = await punchBySerial('M-20260617-0042', { idempotencyKey: 'idem-abc' });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.replay, true);
  }
});

test('punchBySerial returns {ok:false} with reason code on 409 exhausted', async () => {
  stubFetch({ status: 409, body: { ok: false, error: 'exhausted' } });
  const res = await punchBySerial('M-20260617-0042');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 409);
    assert.equal(res.error, 'exhausted');
  }
});
