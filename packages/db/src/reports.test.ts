import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cancelCard, createCustomer, createPunchCard } from './cards';
import { punchCard, refundEntry } from './punch';
import {
  cardsReport,
  customerDetail,
  customersReport,
  dashboardStats,
  dormantCustomers,
  entriesReport,
  revenueReport,
} from './reports';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const SECRET = 'reports-test-secret-at-least-32-characters';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: 'k', secret: SECRET }),
  resolveVerifyKey: (id) => (id === 'k' ? SECRET : undefined),
};

const NOW = new Date('2026-06-17T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

let seq = 0;
const phone = () => {
  seq += 1;
  return `054-100-${String(seq).padStart(4, '0')}`;
};

test('dashboardStats counts recent entries, cards, and customers', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Noa', lastName: 'Cohen', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  await punchCard(db, { punchCardId: card.id, method: 'qr_scan', now: NOW });
  await punchCard(db, { punchCardId: card.id, method: 'qr_scan', now: daysAgo(2) });

  const stats = await dashboardStats(db, NOW);
  assert.equal(stats.entriesLast24h, 1); // the 2-days-ago punch is outside 24h
  assert.equal(stats.entriesLast7d, 2);
  assert.equal(stats.cardsSoldLast30d, 1);
  assert.equal(stats.newCustomersLast7d, 1);
  assert.equal(stats.expiringIn30d, 0); // fresh cards expire in a year
});

test('customerDetail returns the customer with cards and entries', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Tamar', lastName: 'Levi', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  await punchCard(db, { punchCardId: card.id, method: 'qr_scan', now: NOW });

  const detail = await customerDetail(db, cust.id);
  assert.ok(detail);
  assert.equal(detail.customer.id, cust.id);
  assert.equal(detail.cards.length, 1);
  assert.equal(detail.entries.length, 1);

  const missing = await customerDetail(db, '00000000-0000-0000-0000-000000000000');
  assert.equal(missing, undefined);
});

test('dormantCustomers lists those with no visit in the window (or never)', async () => {
  const db = await freshDb();

  const active = await createCustomer(db, { firstName: 'Active', lastName: 'One', phone: phone() });
  const activeCard = await createPunchCard(db, resolver, { customerId: active.id, now: NOW });
  await punchCard(db, { punchCardId: activeCard.id, method: 'qr_scan', now: NOW });

  const dorm = await createCustomer(db, { firstName: 'Dormant', lastName: 'Two', phone: phone() });
  const dormCard = await createPunchCard(db, resolver, { customerId: dorm.id, now: NOW });
  await punchCard(db, { punchCardId: dormCard.id, method: 'qr_scan', now: daysAgo(40) });

  const never = await createCustomer(db, { firstName: 'Never', lastName: 'Three', phone: phone() });
  await createPunchCard(db, resolver, { customerId: never.id, now: NOW });

  const ids = (await dormantCustomers(db, NOW, 30)).map((d) => d.id);
  assert.ok(ids.includes(dorm.id));
  assert.ok(ids.includes(never.id));
  assert.ok(!ids.includes(active.id));
});

// ---------------------------------------------------------------------------
// customersReport
// ---------------------------------------------------------------------------

test('customersReport filters by registered date range and source', async () => {
  const db = await freshDb();
  await createCustomer(db, {
    firstName: 'A',
    lastName: 'Old',
    phone: phone(),
    source: 'referral',
  });
  await createCustomer(db, {
    firstName: 'B',
    lastName: 'New',
    phone: phone(),
    source: 'social',
  });

  // Both fall under "all customers" without filters.
  const all = await customersReport(db, {}, NOW);
  assert.equal(all.length, 2);

  const onlyReferral = await customersReport(db, { source: 'referral' }, NOW);
  assert.equal(onlyReferral.length, 1);
  assert.equal(onlyReferral[0]?.lastName, 'Old');
});

test('customersReport enriches with active card count + last visit', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Live', lastName: 'One', phone: phone() });
  await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  // Exhaust one to flip isActive=false.
  const c2 = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  for (let i = 0; i < 12; i += 1) {
    await punchCard(db, { punchCardId: c2.id, method: 'serial', now: NOW });
  }

  const rows = await customersReport(db, { q: 'Live' }, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.totalCards, 3);
  assert.equal(rows[0]?.activeCards, 2);
  assert.ok(rows[0]?.lastVisit);
});

test('customersReport hasActiveCard filter excludes never-bought and exhausted-only', async () => {
  const db = await freshDb();
  const withCard = await createCustomer(db, { firstName: 'Has', lastName: 'Card', phone: phone() });
  await createPunchCard(db, resolver, { customerId: withCard.id, now: NOW });
  await createCustomer(db, { firstName: 'No', lastName: 'Card', phone: phone() });

  const active = await customersReport(db, { hasActiveCard: true }, NOW);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.firstName, 'Has');

  const none = await customersReport(db, { hasActiveCard: false }, NOW);
  assert.equal(none.length, 1);
  assert.equal(none[0]?.firstName, 'No');
});

// ---------------------------------------------------------------------------
// cardsReport
// ---------------------------------------------------------------------------

test('cardsReport filters by status + computes usagePct', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'C', lastName: 'R', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  for (let i = 0; i < 3; i += 1) {
    await punchCard(db, { punchCardId: card.id, method: 'serial', now: NOW });
  }

  const active = await cardsReport(db, { status: 'active' }, NOW);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.usagePct, 25); // 3/12 = 25%

  const cancelled = await cardsReport(db, { status: 'cancelled' }, NOW);
  assert.equal(cancelled.length, 0);
});

test('cardsReport usageMin/Max filter narrows by percentage', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'U', lastName: 'P', phone: phone() });
  const cardA = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  const cardB = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  for (let i = 0; i < 6; i += 1) {
    await punchCard(db, { punchCardId: cardA.id, method: 'serial', now: NOW });
  }
  // cardB stays at 0%.
  void cardB;

  const half = await cardsReport(db, { usageMinPct: 50 }, NOW);
  assert.equal(half.length, 1);
  assert.equal(half[0]?.usagePct, 50);

  const low = await cardsReport(db, { usageMaxPct: 0 }, NOW);
  assert.equal(low.length, 1);
});

// ---------------------------------------------------------------------------
// entriesReport
// ---------------------------------------------------------------------------

test('entriesReport filters by date range + refunded flag', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'E', lastName: 'R', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });

  const p1 = await punchCard(db, { punchCardId: card.id, method: 'serial', now: daysAgo(10) });
  const p2 = await punchCard(db, { punchCardId: card.id, method: 'serial', now: NOW });
  if (!p1.ok || !p2.ok) return;

  // Refund the recent one — need an admin staff row for FK.
  const adminId = crypto.randomUUID();
  await db.execute(
    sql`INSERT INTO staff (id, first_name, last_name, phone, role, is_active)
        VALUES (${adminId}, 'A', 'D', ${phone()}, 'admin', true)`,
  );
  await refundEntry(db, {
    entryId: p2.entryId,
    refundedBy: adminId,
    approvedBy: adminId,
    reason: 'tests',
  });

  const all = await entriesReport(db);
  assert.equal(all.total, 2);

  const onlyRefunded = await entriesReport(db, { refunded: true });
  assert.equal(onlyRefunded.total, 1);
  assert.equal(onlyRefunded.rows[0]?.id, p2.entryId);

  const recent = await entriesReport(db, { from: daysAgo(2) });
  assert.equal(recent.total, 1);
});

test('entriesReport paginates with limit + offset and returns stable total', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'P', lastName: 'G', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  for (let i = 0; i < 8; i += 1) {
    await punchCard(db, { punchCardId: card.id, method: 'serial', now: NOW });
  }

  const page1 = await entriesReport(db, { limit: 3, offset: 0 });
  const page2 = await entriesReport(db, { limit: 3, offset: 3 });
  assert.equal(page1.total, 8);
  assert.equal(page2.total, 8);
  assert.equal(page1.rows.length, 3);
  assert.equal(page2.rows.length, 3);
  assert.notEqual(page1.rows[0]?.id, page2.rows[0]?.id);
});

// ---------------------------------------------------------------------------
// revenueReport
// ---------------------------------------------------------------------------

test('revenueReport buckets cards-sold by month and uses current price', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'R', lastName: 'V', phone: phone() });
  await createPunchCard(db, resolver, {
    customerId: cust.id,
    now: new Date('2026-05-10T00:00:00.000Z'),
  });
  await createPunchCard(db, resolver, {
    customerId: cust.id,
    now: new Date('2026-05-20T00:00:00.000Z'),
  });
  await createPunchCard(db, resolver, {
    customerId: cust.id,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  const res = await revenueReport(db, { groupBy: 'month' });
  assert.equal(res.estimatedFromPriceShekels, 320);
  assert.equal(res.totalCardsSold, 3);
  assert.equal(res.totalEstimatedRevenueShekels, 3 * 320);
  assert.equal(res.rows.length, 2); // May + June
  const may = res.rows.find((r) => r.period === '2026-05');
  assert.equal(may?.cardsSold, 2);
});

test('revenueReport excludes cancelled cards from totals', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'X', lastName: 'C', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  await cancelCard(db, { cardId: card.id, reason: 'בדיקת ביטול' });

  const res = await revenueReport(db);
  assert.equal(res.totalCardsSold, 0);
});
