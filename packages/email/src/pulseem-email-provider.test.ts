import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { PulseemEmailProvider } from './pulseem-email-provider';

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

function make(extra: { responses?: typeof responseQueue; baseUrl?: string } = {}) {
  if (extra.responses) responseQueue = [...extra.responses];
  return new PulseemEmailProvider({
    apiKey: 'pk-test-abc',
    fromEmail: 'noreply@memesh.co.il',
    fromName: 'Memesh',
    fetchImpl: makeFetch(),
    ...(extra.baseUrl !== undefined && { baseUrl: extra.baseUrl }),
  });
}

test('constructor throws when apiKey is missing', () => {
  assert.throws(
    () =>
      new PulseemEmailProvider({
        apiKey: '',
        fromEmail: 'noreply@memesh.co.il',
        fromName: 'Memesh',
      }),
    /apiKey is required/,
  );
});

test('constructor throws when fromEmail is missing', () => {
  assert.throws(
    () => new PulseemEmailProvider({ apiKey: 'k', fromEmail: '', fromName: 'Memesh' }),
    /fromEmail is required/,
  );
});

test('constructor throws when fromName is missing', () => {
  assert.throws(
    () =>
      new PulseemEmailProvider({
        apiKey: 'k',
        fromEmail: 'noreply@memesh.co.il',
        fromName: '',
      }),
    /fromName is required/,
  );
});

test('send POSTs to the documented endpoint with APIKEY header and JSON body', async () => {
  const p = make({
    responses: [{ status: 200, body: { status: 'Success', success: 1, sessionId: 'sess-1' } }],
  });
  const res = await p.send({
    to: 'customer@example.com',
    subject: 'הכרטיסייה שלך ב-Memesh מוכנה',
    text: 'הכרטיסייה שלך נוצרה',
    html: '<html dir="rtl"><body><p>הכרטיסייה שלך נוצרה</p></body></html>',
  });

  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.id, 'sess-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.url, 'https://api.pulseem.com/api/v1/EmailApi/SendEmail');

  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  // Pulseem's server expects the literal header name "APIKEY", not the
  // swagger-documented "X-Api-Key". Verified for the SMS endpoint
  // 2026-06-21; the email endpoint runs on the same server so we use the
  // same header here. If Pulseem ever switches to X-Api-Key the email
  // path will fail and we'll update both providers in lockstep.
  assert.equal(headers?.['APIKEY'], 'pk-test-abc');
  assert.equal(headers?.['X-Api-Key'], undefined);
  assert.equal(headers?.['Content-Type'], 'application/json');
  assert.equal(headers?.['Authorization'], undefined);
});

test('send body shape: sendId + emailSendData with parallel arrays; NO isAsync', async () => {
  const p = make({ responses: [{ status: 200, body: { status: 'Success', success: 1 } }] });
  await p.send({
    to: 'customer@example.com',
    subject: 'הזמנה התקבלה',
    text: 'תודה שרכשת',
    html: '<p>תודה שרכשת</p>',
  });
  const parsed = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown> & {
    sendId: string;
    emailSendData: {
      fromEmail: string;
      fromName: string;
      subject: string[];
      html: string[];
      toEmails: string[];
      toNames: string[];
      externalRef: string[];
    };
  };

  assert.equal(typeof parsed.sendId, 'string');
  assert.ok(parsed.sendId.length >= 32, 'sendId should look like a UUID');
  // Deliberately omitted — see SMS provider comment for why isAsync trips
  // a 500 on the SMS endpoint. We default the same omission for safety
  // until we have a verified positive case requiring it.
  assert.equal((parsed as Record<string, unknown>).isAsync, undefined);

  assert.equal(parsed.emailSendData.fromEmail, 'noreply@memesh.co.il');
  assert.equal(parsed.emailSendData.fromName, 'Memesh');
  assert.deepEqual(parsed.emailSendData.subject, ['הזמנה התקבלה']);
  assert.deepEqual(parsed.emailSendData.html, ['<p>תודה שרכשת</p>']);
  assert.deepEqual(parsed.emailSendData.toEmails, ['customer@example.com']);
  // externalRef is parallel-array — one fresh uuid per send so a future
  // delivery webhook can correlate per-recipient.
  assert.equal(parsed.emailSendData.externalRef.length, 1);
  assert.ok(parsed.emailSendData.externalRef[0]?.length ?? 0 >= 32);
});

test('send returns ok:false on invalid email (no @)', async () => {
  // No fetch happens — we never reach the network because the local
  // validation catches the malformed address.
  const p = make();
  const res = await p.send({ to: 'not-an-email', subject: 'x', text: 'y' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'invalid_email');
  assert.equal(calls.length, 0, 'no network call attempted');
});

test('send wraps plain-text body in RTL <pre> when html is not provided', async () => {
  const p = make({ responses: [{ status: 200, body: { status: 'Success', success: 1 } }] });
  await p.send({
    to: 'customer@example.com',
    subject: 'בדיקה',
    text: 'שלום, זאת בדיקה',
    // no html
  });
  const parsed = JSON.parse(String(calls[0]?.init.body));
  const html: string = parsed.emailSendData.html[0];
  assert.match(html, /dir="rtl"/);
  assert.match(html, /lang="he"/);
  assert.match(html, /<pre/);
  assert.ok(html.includes('שלום, זאת בדיקה'));
});

test('send escapes HTML-special characters when falling back to <pre>', async () => {
  // Without escaping, a customer name like "O'Brien <admin>" embedded in
  // the plain text would break out of the <pre> and inject markup.
  const p = make({ responses: [{ status: 200, body: { status: 'Success', success: 1 } }] });
  await p.send({
    to: 'customer@example.com',
    subject: 'x',
    text: `<script>alert('xss')</script> O'Brien & "quotes"`,
  });
  const parsed = JSON.parse(String(calls[0]?.init.body));
  const html: string = parsed.emailSendData.html[0];
  assert.equal(html.includes('<script>'), false, 'raw <script> must be escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&#39;xss&#39;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;quotes&quot;/);
});

test('send treats HTTP 200 + body status="Error" as a failure (Pulseem app-level errors)', async () => {
  const p = make({
    responses: [
      {
        status: 200,
        body: {
          status: 'Error',
          error: 'Unauthorized fromEmail',
          success: 0,
          failure: 1,
        },
      },
    ],
  });
  const res = await p.send({
    to: 'customer@example.com',
    subject: 'x',
    text: 'y',
    html: '<p>y</p>',
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'Unauthorized fromEmail');
});

test('send surfaces HTTP-level error (e.g. 500) with body text or parsed error', async () => {
  const p = make({
    responses: [{ status: 500, text: 'Server Error' }],
  });
  const res = await p.send({
    to: 'customer@example.com',
    subject: 'x',
    text: 'y',
    html: '<p>y</p>',
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.error?.includes('Server Error') || res.error?.includes('http_500'));
});

test('send returns ok:false with network: prefix when fetch throws', async () => {
  responseQueue = []; // no stubbed responses → fetch throws
  const p = new PulseemEmailProvider({
    apiKey: 'k',
    fromEmail: 'noreply@memesh.co.il',
    fromName: 'Memesh',
    fetchImpl: makeFetch(),
  });
  const res = await p.send({
    to: 'customer@example.com',
    subject: 'x',
    text: 'y',
    html: '<p>y</p>',
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error ?? '', /^network:/);
});

test('send honors a baseUrl override for staging / regional envs', async () => {
  const p = make({
    responses: [{ status: 200, body: { status: 'Success', success: 1 } }],
    baseUrl: 'https://api.pulseem.com/staging',
  });
  await p.send({ to: 'c@example.com', subject: 'x', text: 'y', html: '<p>y</p>' });
  assert.equal(calls[0]?.url, 'https://api.pulseem.com/staging/api/v1/EmailApi/SendEmail');
});
