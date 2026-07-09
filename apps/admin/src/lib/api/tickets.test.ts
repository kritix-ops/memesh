// Client tests for the tickets (bookings) fetchers — URL building for the
// report endpoint and the participant-action wrappers the ניהול כרטיסים
// screen drives (plan 2026-07-09-admin-tickets-management).

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fetchTicketsReport } from './reports';
import { listRoundsForDate, setTicketArrival } from './round-participants';

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

const EMPTY_PAGE = {
  rows: [],
  total: 0,
  summary: { confirmed: 0, used: 0, cancelled: 0, expired: 0, companions: 0 },
};

test('fetchTicketsReport builds /admin/reports/tickets with every filter', async () => {
  stubFetch({ status: 200, body: EMPTY_PAGE });
  const res = await fetchTicketsReport({
    q: 'R-20260711',
    status: 'confirmed',
    source: 'punchcard',
    ticketType: 'child_over_walking',
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    limit: 50,
    offset: 100,
    sort: 'date',
    sortDir: 'asc',
  });
  assert.equal(res.ok, true);
  const url = new URL(lastCall!.url, 'http://x');
  assert.ok(url.pathname.endsWith('/admin/reports/tickets'));
  assert.equal(url.searchParams.get('q'), 'R-20260711');
  assert.equal(url.searchParams.get('status'), 'confirmed');
  assert.equal(url.searchParams.get('source'), 'punchcard');
  assert.equal(url.searchParams.get('ticketType'), 'child_over_walking');
  assert.equal(url.searchParams.get('dateFrom'), '2026-07-01');
  assert.equal(url.searchParams.get('dateTo'), '2026-07-31');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('offset'), '100');
  assert.equal(url.searchParams.get('sort'), 'date');
  assert.equal(url.searchParams.get('sortDir'), 'asc');
});

test('fetchTicketsReport omits empty filters entirely', async () => {
  stubFetch({ status: 200, body: EMPTY_PAGE });
  const res = await fetchTicketsReport({});
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.data, EMPTY_PAGE);
  }
  assert.ok(lastCall!.url.endsWith('/admin/reports/tickets'), `unexpected url ${lastCall!.url}`);
});

test('fetchTicketsReport surfaces the error union on 403', async () => {
  stubFetch({ status: 403, body: { error: 'forbidden' } });
  const res = await fetchTicketsReport({ status: 'used' });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 403);
    assert.equal(res.error, 'forbidden');
  }
});

test('setTicketArrival POSTs the arrival flag to the staff endpoint', async () => {
  stubFetch({ status: 200, body: { arrived: true, usedAt: '2026-07-11T09:30:00.000Z', changed: true } });
  const res = await setTicketArrival('11111111-1111-1111-1111-111111111111', true);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.arrived, true);
    assert.equal(res.data.changed, true);
  }
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(
    lastCall?.url.endsWith('/staff/rounds/bookings/11111111-1111-1111-1111-111111111111/arrival'),
  );
  assert.equal(lastCall?.init.body, JSON.stringify({ arrived: true }));
});

test('listRoundsForDate reads the staff floor endpoint for that date', async () => {
  stubFetch({ status: 200, body: { date: '2026-07-11', rounds: [] } });
  const res = await listRoundsForDate('2026-07-11');
  assert.equal(res.ok, true);
  assert.ok(lastCall?.url.endsWith('/staff/rounds/today?date=2026-07-11'));
});
