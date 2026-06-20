import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ResendProvider } from './resend-provider';

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let responseQueue: { status: number; body?: unknown; text?: string }[] = [];

function makeFetch(): typeof fetch {
  return (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responseQueue.shift();
    if (!next) throw new Error(`[test] no more stubbed responses; got ${calls.length} calls`);
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
  return new ResendProvider({
    apiKey: 're_test_key',
    from: 'Memesh <noreply@memesh.co.il>',
    fetchImpl: makeFetch(),
  });
}

test('constructor throws when apiKey is missing', () => {
  assert.throws(
    () => new ResendProvider({ apiKey: '', from: 'a@b.com' }),
    /apiKey is required/,
  );
});

test('constructor throws when from is missing', () => {
  assert.throws(
    () => new ResendProvider({ apiKey: 'k', from: '' }),
    /from.*required/,
  );
});

test('send POSTs to /emails with Bearer auth + JSON body + User-Agent (avoids 403/1010)', async () => {
  const p = make({ responses: [{ status: 200, body: { id: 'msg_abc123' } }] });
  const res = await p.send({
    to: 'noa@example.com',
    subject: 'OTP',
    text: 'הקוד הוא 482719',
  });

  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.id, 'msg_abc123');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.url, 'https://api.resend.com/emails');

  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  assert.equal(headers?.['Authorization'], 'Bearer re_test_key');
  assert.equal(headers?.['Content-Type'], 'application/json');
  assert.ok(headers?.['User-Agent'], 'User-Agent header must be set');
  // Idempotency-Key is generated per send so a retry of the same OTP delivery
  // does not double-send if the first response was lost.
  assert.ok(headers?.['Idempotency-Key']?.length, 'Idempotency-Key header must be set');
});

test('send body shape: from + to (as array) + subject + text (+ optional html)', async () => {
  const p = make({ responses: [{ status: 200, body: { id: 'msg_1' } }] });
  await p.send({
    to: 'noa@example.com',
    subject: 'קוד הכניסה',
    text: 'plain',
    html: '<p>html</p>',
  });
  const parsed = JSON.parse(String(calls[0]?.init.body)) as {
    from: string;
    to: string[];
    subject: string;
    text: string;
    html?: string;
  };
  assert.equal(parsed.from, 'Memesh <noreply@memesh.co.il>');
  assert.deepEqual(parsed.to, ['noa@example.com']);
  assert.equal(parsed.subject, 'קוד הכניסה');
  assert.equal(parsed.text, 'plain');
  assert.equal(parsed.html, '<p>html</p>');
});

test('send omits html field when not provided (text-only OTP messages)', async () => {
  const p = make({ responses: [{ status: 200, body: { id: 'msg_2' } }] });
  await p.send({ to: 'a@example.com', subject: 's', text: 't' });
  const parsed = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  assert.equal('html' in parsed, false);
});

test('send returns ok:false on HTTP 4xx, preferring the server message', async () => {
  const p = make({
    responses: [{ status: 422, body: { name: 'validation_error', message: 'invalid_to' } }],
  });
  const res = await p.send({ to: 'bad', subject: 's', text: 't' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'invalid_to');
});

test('send returns ok:false on HTTP 500 with a generic http_500 when body is empty', async () => {
  const p = make({ responses: [{ status: 500, text: '' }] });
  const res = await p.send({ to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'http_500');
});

test('send returns ok:false with the network error message when fetch throws', async () => {
  const failingFetch: typeof fetch = async () => {
    throw new Error('connect ETIMEDOUT');
  };
  const p = new ResendProvider({
    apiKey: 'k',
    from: 'Memesh <n@m.com>',
    fetchImpl: failingFetch,
  });
  const res = await p.send({ to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /network: connect ETIMEDOUT/);
});

test('send falls back to the generated idempotency key when the server omits id', async () => {
  const p = make({ responses: [{ status: 200, body: {} }] });
  const res = await p.send({ to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(res.ok, true);
  if (res.ok) assert.match(res.id ?? '', /^[0-9a-f-]{36}$/);
});

test('send uses a custom baseUrl when provided', async () => {
  const p = new ResendProvider({
    apiKey: 'k',
    from: 'Memesh <n@m.com>',
    baseUrl: 'https://api.resend.com/staging',
    fetchImpl: makeFetch(),
  });
  responseQueue = [{ status: 200, body: { id: 'x' } }];
  await p.send({ to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(calls[0]?.url, 'https://api.resend.com/staging/emails');
});
