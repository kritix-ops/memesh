import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Sms019Provider } from './019-provider';

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let responseQueue: { status: number; body?: unknown; text?: string }[] = [];

function makeFetch(): typeof fetch {
  // Use a loose signature: globalThis.fetch's exact parameter types differ
  // between @types/node (undici) and DOM lib. We only care about `String(input)`
  // and inspecting init.
  return (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responseQueue.shift();
    if (!next) {
      throw new Error(`[test] no more stubbed responses; got ${calls.length} calls`);
    }
    const body = next.text ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    return new Response(body, {
      status: next.status,
      headers: body && next.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  responseQueue = [];
});

function make(extra: { responses?: typeof responseQueue } = {}) {
  if (extra.responses) responseQueue = [...extra.responses];
  return new Sms019Provider({
    token: 'tok-abc',
    source: 'MEMESH',
    fetchImpl: makeFetch(),
  });
}

test('constructor throws when token is missing', () => {
  assert.throws(() => new Sms019Provider({ token: '', source: 'MEMESH' }), /token is required/);
});

test('constructor throws when source is missing or too long', () => {
  assert.throws(() => new Sms019Provider({ token: 't', source: '' }), /source.*required/);
  assert.throws(
    () => new Sms019Provider({ token: 't', source: 'WAY_TOO_LONG_FOR_SENDER_ID' }),
    /at most 11 characters/,
  );
});

test('send POSTs to the configured endpoint with Bearer auth + JSON body', async () => {
  const p = make({ responses: [{ status: 200, body: { status: 0, id: 'srv-1' } }] });
  const res = await p.send({ to: '052-345-6789', body: 'hello' });

  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.id, 'srv-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.url, 'https://019sms.co.il/api/test');

  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  assert.equal(headers?.['Authorization'], 'Bearer tok-abc');
  assert.equal(headers?.['Content-Type'], 'application/json');
});

test('send normalizes the phone before posting (strips dashes, drops +972)', async () => {
  const p = make({ responses: [{ status: 200, body: { status: 0 } }] });
  await p.send({ to: '+972 52 345 6789', body: 'hi' });
  const parsed = JSON.parse(String(calls[0]?.init.body)) as {
    destinations: { phone: string };
  };
  assert.equal(parsed.destinations.phone, '0523456789');
});

test('send body shape: source + destinations.phone + message', async () => {
  const p = make({ responses: [{ status: 200, body: { status: 0 } }] });
  await p.send({ to: '0523456789', body: 'קוד הכניסה: 482719' });
  const parsed = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    source: 'MEMESH',
    destinations: { phone: '0523456789' },
    message: 'קוד הכניסה: 482719',
  });
});

test('send returns ok:true with an id when the server returns status=0', async () => {
  const p = make({ responses: [{ status: 200, body: { status: 0, id: 12345 } }] });
  const res = await p.send({ to: '0523456789', body: 'x' });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.id, '12345');
});

test('send returns ok:false on HTTP 4xx with the server message when present', async () => {
  const p = make({
    responses: [{ status: 401, body: { status: 1, message: 'invalid_token' } }],
  });
  const res = await p.send({ to: '0523456789', body: 'x' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'invalid_token');
});

test('send returns ok:false on a non-zero status inside a 200 body', async () => {
  const p = make({
    responses: [{ status: 200, body: { status: 7, message: 'insufficient_balance' } }],
  });
  const res = await p.send({ to: '0523456789', body: 'x' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'insufficient_balance');
});

test('send returns ok:false with normalized error when the phone cannot be normalized', async () => {
  const p = make({ responses: [] });
  const res = await p.send({ to: '', body: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /phone is required/);
  // No HTTP call was made.
  assert.equal(calls.length, 0);
});

test('send uses a custom endpoint when provided (production override)', async () => {
  const p = new Sms019Provider({
    token: 'tok',
    source: 'MEMESH',
    endpoint: 'https://019sms.co.il/api',
    fetchImpl: makeFetch(),
  });
  responseQueue = [{ status: 200, body: { status: 0 } }];
  await p.send({ to: '0523456789', body: 'x' });
  assert.equal(calls[0]?.url, 'https://019sms.co.il/api');
});
