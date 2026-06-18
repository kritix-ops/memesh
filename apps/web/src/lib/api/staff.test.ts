import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createStaffMember, listStaff } from './staff';

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

test('listStaff fetches /staff and unwraps the array', async () => {
  stubFetch({
    status: 200,
    body: {
      staff: [
        {
          id: 's1',
          firstName: 'Maya',
          lastName: 'Barak',
          phone: '050-100-0001',
          email: null,
          role: 'admin',
          isActive: true,
          createdAt: '2026-06-18T10:00:00.000Z',
        },
      ],
    },
  });
  const res = await listStaff();
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.staff.length, 1);
    assert.equal(res.data.staff[0]?.role, 'admin');
  }
  assert.ok(lastCall?.url.endsWith('/staff'));
});

test('createStaffMember POSTs /staff with the input', async () => {
  stubFetch({
    status: 201,
    body: {
      staff: {
        id: 's-new',
        firstName: 'Idan',
        lastName: 'Rosen',
        phone: '054-200-0002',
        email: null,
        role: 'manager',
        isActive: true,
        createdAt: '2026-06-18T10:00:00.000Z',
      },
    },
  });
  const res = await createStaffMember({
    firstName: 'Idan',
    lastName: 'Rosen',
    phone: '054-200-0002',
    password: 'a-strong-pw-1!',
    role: 'manager',
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.staff.role, 'manager');
  }
  assert.equal(lastCall?.init.method, 'POST');
  assert.ok(lastCall?.url.endsWith('/staff'));
  assert.equal(
    lastCall?.init.body,
    JSON.stringify({
      firstName: 'Idan',
      lastName: 'Rosen',
      phone: '054-200-0002',
      password: 'a-strong-pw-1!',
      role: 'manager',
    }),
  );
});

test('createStaffMember surfaces 409 phone_taken on collision', async () => {
  stubFetch({ status: 409, body: { error: 'phone_taken' } });
  const res = await createStaffMember({
    firstName: 'X',
    lastName: 'Y',
    phone: '054-200-0002',
    password: 'pw',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 409);
    assert.equal(res.error, 'phone_taken');
  }
});
