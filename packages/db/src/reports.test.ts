import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer, createPunchCard } from './cards';
import { punchCard } from './punch';
import { customerDetail, dashboardStats, dormantCustomers } from './reports';

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
