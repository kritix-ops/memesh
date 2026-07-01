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
  cancellationsReport,
  cardsReport,
  customerDetail,
  customersReport,
  dashboardStats,
  dormantCustomers,
  entriesReport,
  revenueReport,
} from './reports';
import { bookings, roundInstances, rounds } from './schema';

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

test('dashboardStats excludes refunded entries and cancelled cards', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Ref', lastName: 'Und', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  const kept = await punchCard(db, { punchCardId: card.id, method: 'serial', now: NOW });
  const refunded = await punchCard(db, { punchCardId: card.id, method: 'serial', now: NOW });
  if (!kept.ok || !refunded.ok) return;

  const adminId = crypto.randomUUID();
  await db.execute(
    sql`INSERT INTO staff (id, first_name, last_name, phone, role, is_active)
        VALUES (${adminId}, 'A', 'D', ${phone()}, 'admin', true)`,
  );
  await refundEntry(db, {
    entryId: refunded.entryId,
    refundedBy: adminId,
    approvedBy: adminId,
    reason: 'בדיקת החזר',
    now: NOW,
  });

  // A cancelled card sold this month is a return, not a sale.
  const cancelled = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  await cancelCard(db, { cardId: cancelled.id, reason: 'בדיקת ביטול', now: NOW });

  const stats = await dashboardStats(db, NOW);
  assert.equal(stats.entriesLast24h, 1); // the refunded punch no longer counts
  assert.equal(stats.entriesLast30d, 1);
  assert.equal(stats.cardsSoldLast30d, 1); // card + cancelled card → only the live one
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

test('customersReport hasActiveCard treats a date-expired card as inactive', async () => {
  const db = await freshDb();
  const expiredOnly = await createCustomer(db, { firstName: 'Ex', lastName: 'Pired', phone: phone() });
  // Sold 10 days ago with 1-day validity → expired 9 days ago; is_active
  // stays true in the row, so only an expiry-aware filter catches it.
  await createPunchCard(db, resolver, {
    customerId: expiredOnly.id,
    validityDays: 1,
    now: daysAgo(10),
  });
  const live = await createCustomer(db, { firstName: 'Li', lastName: 'Ve', phone: phone() });
  await createPunchCard(db, resolver, { customerId: live.id, now: NOW });

  const withActive = await customersReport(db, { hasActiveCard: true }, NOW);
  assert.deepEqual(withActive.map((r) => r.id), [live.id]);
  const withoutActive = await customersReport(db, { hasActiveCard: false }, NOW);
  assert.deepEqual(withoutActive.map((r) => r.id), [expiredOnly.id]);
});

test('customersReport dormantSinceDays filters before the row limit', async () => {
  const db = await freshDb();
  // Dormant customer registered FIRST — under createdAt desc it is the last
  // row fetched, so a JS post-filter after LIMIT 1 would have missed it.
  const dorm = await createCustomer(db, { firstName: 'Dor', lastName: 'Mant', phone: phone() });
  const dormCard = await createPunchCard(db, resolver, { customerId: dorm.id, now: daysAgo(60) });
  await punchCard(db, { punchCardId: dormCard.id, method: 'serial', now: daysAgo(45) });
  const fresh = await createCustomer(db, { firstName: 'Fre', lastName: 'Sh', phone: phone() });
  const freshCard = await createPunchCard(db, resolver, { customerId: fresh.id, now: NOW });
  await punchCard(db, { punchCardId: freshCard.id, method: 'serial', now: daysAgo(2) });

  const rows = await customersReport(db, { dormantSinceDays: 30, limit: 1 }, NOW);
  assert.deepEqual(rows.map((r) => r.id), [dorm.id]);
});

test('customersReport sorts by lastVisit in SQL, never-visited as oldest', async () => {
  const db = await freshDb();
  const recent = await createCustomer(db, { firstName: 'Re', lastName: 'Cent', phone: phone() });
  const rc = await createPunchCard(db, resolver, { customerId: recent.id, now: NOW });
  await punchCard(db, { punchCardId: rc.id, method: 'serial', now: daysAgo(1) });
  const older = await createCustomer(db, { firstName: 'Ol', lastName: 'Der', phone: phone() });
  const oc = await createPunchCard(db, resolver, { customerId: older.id, now: NOW });
  await punchCard(db, { punchCardId: oc.id, method: 'serial', now: daysAgo(5) });
  const never = await createCustomer(db, { firstName: 'Ne', lastName: 'Ver', phone: phone() });

  const desc = await customersReport(db, { sort: 'lastVisit', sortDir: 'desc' }, NOW);
  assert.deepEqual(desc.map((r) => r.id), [recent.id, older.id, never.id]);
  const asc = await customersReport(db, { sort: 'lastVisit', sortDir: 'asc' }, NOW);
  assert.deepEqual(asc.map((r) => r.id), [never.id, older.id, recent.id]);
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

test('cardsReport usage filter applies before the row limit', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Li', lastName: 'Mit', phone: phone() });
  // The matching card is the OLDEST — under createdAt desc it sits past a
  // LIMIT 2 window, so a JS post-filter after the limit would have dropped it.
  const halfUsed = await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(3) });
  for (let i = 0; i < 6; i += 1) {
    await punchCard(db, { punchCardId: halfUsed.id, method: 'serial', now: daysAgo(3) });
  }
  await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(2) });
  await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(1) });

  const rows = await cardsReport(db, { usageMinPct: 50, limit: 2 }, NOW);
  assert.deepEqual(rows.map((r) => r.id), [halfUsed.id]);
});

test('cardsReport status buckets are expiry-aware', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Ti', lastName: 'Me', phone: phone() });
  // Sold 10 days ago with 1-day validity → date-expired; is_active stays true.
  const dateExpired = await createPunchCard(db, resolver, {
    customerId: cust.id,
    validityDays: 1,
    now: daysAgo(10),
  });
  const fresh = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });

  const active = await cardsReport(db, { status: 'active' }, NOW);
  assert.deepEqual(active.map((r) => r.id), [fresh.id]);
  const expired = await cardsReport(db, { status: 'expired' }, NOW);
  assert.deepEqual(expired.map((r) => r.id), [dateExpired.id]);
  assert.equal(expired[0]?.isActive, true); // row flag untouched — bucket derived from expires_at
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

test('revenueReport buckets days by the venue clock (Asia/Jerusalem), not UTC', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Tz', lastName: 'Test', phone: phone() });
  // 22:00 UTC on May 31 is already 01:00 June 1 in Israel (UTC+3 in summer).
  await createPunchCard(db, resolver, {
    customerId: cust.id,
    now: new Date('2026-05-31T22:00:00.000Z'),
  });

  const res = await revenueReport(db, { groupBy: 'day' });
  assert.deepEqual(res.rows.map((r) => r.period), ['2026-06-01']);
});

test('revenueReport excludes cancelled cards from totals', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'X', lastName: 'C', phone: phone() });
  const card = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  await cancelCard(db, { cardId: card.id, reason: 'בדיקת ביטול' });

  const res = await revenueReport(db);
  assert.equal(res.totalCardsSold, 0);
});

test('revenueReport buckets paid companions and merges periods with card sales', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Comp', lastName: 'Anion', phone: phone() });
  // A card sold in May — gives May a cards bucket.
  await createPunchCard(db, resolver, {
    customerId: cust.id,
    now: new Date('2026-05-10T00:00:00.000Z'),
  });

  const [round] = await db
    .insert(rounds)
    .values({
      label: 'afternoon',
      displayName: 'סבב',
      startTime: '16:00:00',
      endTime: '18:00:00',
      defaultCapacity: 50,
    })
    .returning();
  const [instance] = await db
    .insert(roundInstances)
    .values({ roundId: round!.id, date: '2026-05-15', capacity: 50 })
    .returning();

  // Paid companion confirmed in May → merges into the May row.
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: cust.id,
    ticketType: 'child_over_walking',
    additionalCompanions: 1,
    source: 'paid',
    status: 'confirmed',
    confirmedAt: new Date('2026-05-15T10:00:00.000Z'),
  });
  // Paid companion confirmed in June — a period with NO card sales must still
  // appear as its own row.
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: cust.id,
    ticketType: 'child_over_walking',
    additionalCompanions: 1,
    source: 'paid',
    status: 'confirmed',
    confirmedAt: new Date('2026-06-15T10:00:00.000Z'),
  });
  // Comped (manual) companion — must NOT count.
  await db.insert(bookings).values({
    roundInstanceId: instance!.id,
    customerId: cust.id,
    ticketType: 'child_over_walking',
    additionalCompanions: 1,
    source: 'manual',
    status: 'confirmed',
    confirmedAt: new Date('2026-05-15T11:00:00.000Z'),
  });

  const res = await revenueReport(db, { groupBy: 'month' });
  assert.equal(res.totalCardsSold, 1);
  assert.equal(res.totalCompanionsSold, 2);
  assert.equal(res.rows.length, 2); // May (card + companion) + June (companion only)
  const may = res.rows.find((r) => r.period === '2026-05');
  assert.equal(may?.cardsSold, 1);
  assert.equal(may?.companionsSold, 1);
  const june = res.rows.find((r) => r.period === '2026-06');
  assert.equal(june?.cardsSold, 0);
  assert.equal(june?.companionsSold, 1);
  // Revenue estimate stays cards-only.
  assert.equal(june?.estimatedRevenueShekels, 0);
});

// ---------------------------------------------------------------------------
// cancellationsReport
// ---------------------------------------------------------------------------

test('cancellationsReport merges card cancellations and entry refunds, newest first', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Mer', lastName: 'Ge', phone: phone() });

  // Refunded entry, 10 days ago.
  const cardA = await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(20) });
  const p = await punchCard(db, { punchCardId: cardA.id, method: 'serial', now: daysAgo(15) });
  if (!p.ok) return;
  const adminId = crypto.randomUUID();
  await db.execute(
    sql`INSERT INTO staff (id, first_name, last_name, phone, role, is_active)
        VALUES (${adminId}, 'Ad', 'Min', ${phone()}, 'admin', true)`,
  );
  await refundEntry(db, {
    entryId: p.entryId,
    refundedBy: adminId,
    approvedBy: adminId,
    reason: 'תשלום כפול',
    now: daysAgo(10),
  });

  // Cancelled card, today (newest).
  const cardB = await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(5) });
  await cancelCard(db, { cardId: cardB.id, staffId: adminId, reason: 'לקוח התחרט', now: NOW });

  const page = await cancellationsReport(db);
  assert.equal(page.total, 2);
  assert.equal(page.cardCount, 1);
  assert.equal(page.entryCount, 1);

  // Newest (card cancellation today) comes first.
  assert.equal(page.rows[0]?.kind, 'card');
  assert.equal(page.rows[0]?.reason, 'לקוח התחרט');
  assert.equal(page.rows[0]?.actorFirstName, 'Ad');

  assert.equal(page.rows[1]?.kind, 'entry');
  assert.equal(page.rows[1]?.reason, 'תשלום כפול');
  assert.equal(page.rows[1]?.entriesConsumed, 1);
  assert.equal(page.rows[1]?.method, 'serial');
});

test('cancellationsReport pages correctly across sources with SQL-bounded windows', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Pa', lastName: 'Ge', phone: phone() });
  const adminId = crypto.randomUUID();
  await db.execute(
    sql`INSERT INTO staff (id, first_name, last_name, phone, role, is_active)
        VALUES (${adminId}, 'A', 'D', ${phone()}, 'admin', true)`,
  );

  // Two entry refunds — the OLDEST events (6 and 5 days ago).
  const punched = await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(20) });
  const p1 = await punchCard(db, { punchCardId: punched.id, method: 'serial', now: daysAgo(15) });
  const p2 = await punchCard(db, { punchCardId: punched.id, method: 'serial', now: daysAgo(15) });
  if (!p1.ok || !p2.ok) return;
  await refundEntry(db, {
    entryId: p1.entryId,
    refundedBy: adminId,
    approvedBy: adminId,
    reason: 'החזר ראשון',
    now: daysAgo(6),
  });
  await refundEntry(db, {
    entryId: p2.entryId,
    refundedBy: adminId,
    approvedBy: adminId,
    reason: 'החזר שני',
    now: daysAgo(5),
  });

  // Four card cancellations — the NEWEST events (4..1 days ago).
  for (let d = 4; d >= 1; d -= 1) {
    const c = await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(10) });
    await cancelCard(db, { cardId: c.id, reason: `ביטול בדיקה ${d}`, now: daysAgo(d) });
  }

  // Page 3 (offset 4, limit 2) reaches past every card cancellation into the
  // refunds — correct only when each source's SQL window covers offset+limit
  // rows, and counts must reflect the FULL matching sets, not the windows.
  const page = await cancellationsReport(db, { limit: 2, offset: 4 });
  assert.equal(page.total, 6);
  assert.equal(page.cardCount, 4);
  assert.equal(page.entryCount, 2);
  assert.deepEqual(page.rows.map((r) => r.kind), ['entry', 'entry']);
  assert.deepEqual(page.rows.map((r) => r.reason), ['החזר שני', 'החזר ראשון']);
});

test('cancellationsReport kind filter restricts to one source', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Ki', lastName: 'Nd', phone: phone() });
  const cardA = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  await cancelCard(db, { cardId: cardA.id, reason: 'בדיקת ביטול', now: NOW });

  const cardB = await createPunchCard(db, resolver, { customerId: cust.id, now: NOW });
  const p = await punchCard(db, { punchCardId: cardB.id, method: 'serial', now: NOW });
  if (!p.ok) return;
  const adminId = crypto.randomUUID();
  await db.execute(
    sql`INSERT INTO staff (id, first_name, last_name, phone, role, is_active)
        VALUES (${adminId}, 'A', 'D', ${phone()}, 'admin', true)`,
  );
  await refundEntry(db, {
    entryId: p.entryId,
    refundedBy: adminId,
    approvedBy: adminId,
    reason: 'tests',
    now: NOW,
  });

  const onlyCards = await cancellationsReport(db, { kind: 'card' });
  assert.equal(onlyCards.total, 1);
  assert.equal(onlyCards.rows[0]?.kind, 'card');

  const onlyEntries = await cancellationsReport(db, { kind: 'entry' });
  assert.equal(onlyEntries.total, 1);
  assert.equal(onlyEntries.rows[0]?.kind, 'entry');
});

test('cancellationsReport date range filters by occurredAt across both sources', async () => {
  const db = await freshDb();
  const cust = await createCustomer(db, { firstName: 'Da', lastName: 'Te', phone: phone() });

  // Old cancellation (30 days ago).
  const oldCard = await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(40) });
  await cancelCard(db, { cardId: oldCard.id, reason: 'old', now: daysAgo(30) });

  // Recent cancellation (3 days ago).
  const newCard = await createPunchCard(db, resolver, { customerId: cust.id, now: daysAgo(10) });
  await cancelCard(db, { cardId: newCard.id, reason: 'fresh', now: daysAgo(3) });

  const lastWeek = await cancellationsReport(db, { from: daysAgo(7) });
  assert.equal(lastWeek.total, 1);
  assert.equal(lastWeek.rows[0]?.reason, 'fresh');
});

test('cancellationsReport q matches card serial and customer fields', async () => {
  const db = await freshDb();
  const target = await createCustomer(db, {
    firstName: 'Yael',
    lastName: 'Searchable',
    phone: phone(),
  });
  const noise = await createCustomer(db, { firstName: 'Other', lastName: 'Person', phone: phone() });

  const cardT = await createPunchCard(db, resolver, { customerId: target.id, now: NOW });
  await cancelCard(db, { cardId: cardT.id, reason: 'בדיקת ביטול', now: NOW });
  const cardN = await createPunchCard(db, resolver, { customerId: noise.id, now: NOW });
  await cancelCard(db, { cardId: cardN.id, reason: 'בדיקת ביטול', now: NOW });

  const byName = await cancellationsReport(db, { q: 'Searchable' });
  assert.equal(byName.total, 1);
  assert.equal(byName.rows[0]?.customerLastName, 'Searchable');

  const bySerial = await cancellationsReport(db, { q: cardT.serialNumber });
  assert.equal(bySerial.total, 1);
  assert.equal(bySerial.rows[0]?.cardSerial, cardT.serialNumber);
});
