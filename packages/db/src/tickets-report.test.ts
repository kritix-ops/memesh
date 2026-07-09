// Tickets report (plan 2026-07-09-admin-tickets-management): the cross-round
// bookings query feeding both ניהול כרטיסים and the דוחות section — filters,
// pagination, the status-agnostic summary, and the held-rows exclusion.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer, createPunchCard } from './cards';
import { ticketsReport } from './reports';
import { createRound } from './rounds';
import { bookings, roundInstances } from './schema';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

type Db = Awaited<ReturnType<typeof freshDb>>;

const SECRET = 'a-tickets-report-secret-32-chars-min!';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (id) => (id === '1' ? SECRET : undefined),
};

const NOW = new Date(2026, 6, 1, 12, 0, 0);
const DAY_A = '2026-07-11';
const DAY_B = '2026-07-18';
let phoneSeq = 400;
const phone = () => `05200000${(phoneSeq += 1)}`;

async function instanceOn(db: Db, roundId: string, date: string) {
  const row = (
    await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, date)))
      .limit(1)
  )[0];
  if (!row) throw new Error(`no instance on ${date}`);
  return row.id;
}

/**
 * Two rounds (morning/afternoon), two customers, one punch card, and a spread
 * of bookings across dates / statuses / sources — including a held row that
 * must never surface.
 */
async function setup(db: Db) {
  const morning = await createRound(
    db,
    { label: 'morning', displayName: 'בוקר', startTime: '09:00', endTime: '14:00', daysActive: 127, defaultCapacity: 20 },
    NOW,
  );
  const afternoon = await createRound(
    db,
    { label: 'afternoon', displayName: 'צהריים', startTime: '15:00', endTime: '19:00', daysActive: 127, defaultCapacity: 20 },
    NOW,
  );
  if (!morning.ok || !afternoon.ok) throw new Error('round setup failed');

  const noa = await createCustomer(db, { firstName: 'נועה', lastName: 'כהן', phone: phone() });
  const dan = await createCustomer(db, { firstName: 'דן', lastName: 'לוי', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: noa.id });

  const morningA = await instanceOn(db, morning.round.id, DAY_A);
  const afternoonA = await instanceOn(db, afternoon.round.id, DAY_A);
  const morningB = await instanceOn(db, morning.round.id, DAY_B);

  const at = (h: number) => new Date(2026, 6, 1, h, 0, 0);
  await db.insert(bookings).values([
    {
      roundInstanceId: morningA,
      customerId: noa.id,
      ticketType: 'child_over_walking',
      additionalCompanions: 1,
      source: 'punchcard',
      status: 'confirmed',
      bookingNumber: 'R-20260711-0001',
      punchCardId: card.id,
      createdAt: at(8),
    },
    {
      roundInstanceId: afternoonA,
      customerId: dan.id,
      ticketType: 'child_under_walking',
      additionalCompanions: 0,
      source: 'paid',
      status: 'used',
      bookingNumber: 'R-20260711-0002',
      wcOrderId: '7734',
      usedAt: at(15),
      createdAt: at(9),
    },
    {
      roundInstanceId: morningB,
      customerId: dan.id,
      ticketType: 'child_over_walking',
      additionalCompanions: 1,
      source: 'paid',
      status: 'cancelled',
      bookingNumber: 'R-20260718-0003',
      wcOrderId: '7801',
      createdAt: at(10),
    },
    {
      roundInstanceId: morningB,
      customerId: noa.id,
      ticketType: 'child_over_walking',
      additionalCompanions: 0,
      source: 'manual',
      status: 'expired',
      bookingNumber: 'R-20260718-0004',
      createdAt: at(11),
    },
    // The invisible one: a live WC-checkout hold.
    {
      roundInstanceId: morningB,
      customerId: noa.id,
      ticketType: 'child_over_walking',
      additionalCompanions: 0,
      source: 'paid',
      status: 'held',
      holdExpiresAt: at(13),
      createdAt: at(12),
    },
  ]);

  return { noa, dan, card };
}

test('no filters: every non-held ticket, held excluded, summary counts the set', async () => {
  const db = await freshDb();
  await setup(db);

  const page = await ticketsReport(db);
  assert.equal(page.total, 4);
  assert.equal(page.rows.length, 4);
  assert.ok(page.rows.every((r) => r.status !== ('held' as string)));
  assert.deepEqual(page.summary, { confirmed: 1, used: 1, cancelled: 1, expired: 1, companions: 2 });
});

test('rows carry the round, customer, and punch-card joins with HH:MM times', async () => {
  const db = await freshDb();
  const { noa, card } = await setup(db);

  const page = await ticketsReport(db, { status: 'confirmed' });
  const row = page.rows[0]!;
  assert.equal(row.bookingNumber, 'R-20260711-0001');
  assert.equal(row.customerId, noa.id);
  assert.equal(row.customerFirstName, 'נועה');
  assert.equal(row.date, DAY_A);
  assert.equal(row.roundLabel, 'בוקר');
  assert.equal(row.startTime, '09:00');
  assert.equal(row.endTime, '14:00');
  assert.equal(row.punchCardSerial, card.serialNumber);
  assert.equal(row.wcOrderId, null);
});

test('punchCardSerial is null on non-punch tickets', async () => {
  const db = await freshDb();
  await setup(db);

  const page = await ticketsReport(db, { status: 'used' });
  assert.equal(page.rows[0]!.punchCardSerial, null);
  assert.equal(page.rows[0]!.wcOrderId, '7734');
});

test('q matches booking number, name, and phone', async () => {
  const db = await freshDb();
  const { dan } = await setup(db);

  const byNumber = await ticketsReport(db, { q: '20260711-0002' });
  assert.deepEqual(byNumber.rows.map((r) => r.bookingNumber), ['R-20260711-0002']);

  const byName = await ticketsReport(db, { q: 'נועה' });
  assert.equal(byName.total, 2);
  assert.ok(byName.rows.every((r) => r.customerFirstName === 'נועה'));

  const byPhone = await ticketsReport(db, { q: dan.phone.slice(-4) });
  assert.equal(byPhone.total, 2);
  assert.ok(byPhone.rows.every((r) => r.customerId === dan.id));
});

test('status filter narrows rows but the summary keeps the full distribution', async () => {
  const db = await freshDb();
  await setup(db);

  const page = await ticketsReport(db, { status: 'cancelled' });
  assert.equal(page.total, 1);
  assert.equal(page.rows[0]!.bookingNumber, 'R-20260718-0003');
  assert.deepEqual(page.summary, { confirmed: 1, used: 1, cancelled: 1, expired: 1, companions: 2 });
});

test('source and ticketType filters', async () => {
  const db = await freshDb();
  await setup(db);

  const paid = await ticketsReport(db, { source: 'paid' });
  assert.equal(paid.total, 2);
  assert.ok(paid.rows.every((r) => r.source === 'paid'));

  const babies = await ticketsReport(db, { ticketType: 'child_under_walking' });
  assert.deepEqual(babies.rows.map((r) => r.bookingNumber), ['R-20260711-0002']);
});

test('date range filters on the round date, inclusive', async () => {
  const db = await freshDb();
  await setup(db);

  const dayA = await ticketsReport(db, { dateFrom: DAY_A, dateTo: DAY_A });
  assert.equal(dayA.total, 2);
  assert.ok(dayA.rows.every((r) => r.date === DAY_A));
  // Summary follows the date filter too — only day-A statuses counted.
  assert.deepEqual(dayA.summary, { confirmed: 1, used: 1, cancelled: 0, expired: 0, companions: 1 });
});

test('pagination pages through a stable total', async () => {
  const db = await freshDb();
  await setup(db);

  const first = await ticketsReport(db, { sort: 'createdAt', sortDir: 'asc', limit: 3 });
  const second = await ticketsReport(db, { sort: 'createdAt', sortDir: 'asc', limit: 3, offset: 3 });
  assert.equal(first.total, 4);
  assert.equal(second.total, 4);
  assert.equal(first.rows.length, 3);
  assert.equal(second.rows.length, 1);
  const all = [...first.rows, ...second.rows].map((r) => r.bookingNumber);
  assert.deepEqual(all, ['R-20260711-0001', 'R-20260711-0002', 'R-20260718-0003', 'R-20260718-0004']);
});

test('default sort: round date desc, earlier round first within a day, newest booking first within a round', async () => {
  const db = await freshDb();
  await setup(db);

  const page = await ticketsReport(db);
  assert.deepEqual(
    page.rows.map((r) => r.bookingNumber),
    ['R-20260718-0004', 'R-20260718-0003', 'R-20260711-0001', 'R-20260711-0002'],
  );
});

test('sort by bookingNumber respects sortDir', async () => {
  const db = await freshDb();
  await setup(db);

  const desc = await ticketsReport(db, { sort: 'bookingNumber', sortDir: 'desc', limit: 1 });
  assert.equal(desc.rows[0]!.bookingNumber, 'R-20260718-0004');
});

test('empty database returns an empty page with a zeroed summary', async () => {
  const db = await freshDb();
  const page = await ticketsReport(db);
  assert.equal(page.total, 0);
  assert.deepEqual(page.rows, []);
  assert.deepEqual(page.summary, { confirmed: 0, used: 0, cancelled: 0, expired: 0, companions: 0 });
});
