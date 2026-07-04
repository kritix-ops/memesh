import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { KeyResolver } from '@memesh/qr-engine';
import { cancelCard, createCustomer, createPunchCard } from './cards';
import { listCustomers } from './customer-directory';
import { customers } from './schema/index';

// Test signing key. Just enough surface for createPunchCard to mint a token.
const TEST_SECRET = 'test-secret-that-is-at-least-32-characters';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: 'test-key', secret: TEST_SECRET }),
  resolveVerifyKey: (keyId) => (keyId === 'test-key' ? TEST_SECRET : undefined),
};

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

let seq = 0;
const phone = () => {
  seq += 1;
  return `050-800-${String(seq).padStart(4, '0')}`;
};

type Db = Awaited<ReturnType<typeof freshDb>>;

// Seed helper: customer with a pinned createdAt so ordering assertions are
// deterministic (createCustomer itself uses the row default now()).
async function seedCustomer(
  db: Db,
  firstName: string,
  lastName: string,
  createdAt: Date,
  extra: { email?: string; status?: 'active' | 'frozen' | 'vip' } = {},
) {
  const c = await createCustomer(db, {
    firstName,
    lastName,
    phone: phone(),
    ...(extra.email !== undefined && { email: extra.email }),
  });
  await db
    .update(customers)
    .set({ createdAt, ...(extra.status !== undefined && { status: extra.status }) })
    .where(eq(customers.id, c.id));
  return c;
}

const day = (n: number) => new Date(Date.UTC(2026, 5, n, 10, 0, 0));

test('sort=name orders alphabetically by first then last name', async () => {
  const db = await freshDb();
  await seedCustomer(db, 'דנה', 'לוי', day(1));
  await seedCustomer(db, 'אבי', 'כהן', day(2));
  await seedCustomer(db, 'אבי', 'ברק', day(3));
  const { results, total } = await listCustomers(db, { sort: 'name' });
  assert.equal(total, 3);
  assert.deepEqual(
    results.map((r) => `${r.firstName} ${r.lastName}`),
    ['אבי ברק', 'אבי כהן', 'דנה לוי'],
  );
});

test('sort=newest (the default) orders by createdAt desc; oldest reverses it', async () => {
  const db = await freshDb();
  await seedCustomer(db, 'ותיקה', 'ראשונה', day(1));
  await seedCustomer(db, 'חדשה', 'אחרונה', day(20));
  await seedCustomer(db, 'אמצע', 'אמצעית', day(10));
  const newest = await listCustomers(db);
  assert.deepEqual(
    newest.results.map((r) => r.firstName),
    ['חדשה', 'אמצע', 'ותיקה'],
  );
  const oldest = await listCustomers(db, { sort: 'oldest' });
  assert.deepEqual(
    oldest.results.map((r) => r.firstName),
    ['ותיקה', 'אמצע', 'חדשה'],
  );
});

test('sort=lastPurchase puts recent buyers first and never-bought last', async () => {
  const db = await freshDb();
  const early = await seedCustomer(db, 'קונה', 'מזמן', day(1));
  const recent = await seedCustomer(db, 'קונה', 'טרייה', day(1));
  await seedCustomer(db, 'בלי', 'רכישות', day(25));
  await createPunchCard(db, resolver, { customerId: early.id, now: day(5) });
  await createPunchCard(db, resolver, { customerId: recent.id, now: day(15) });
  // Second, older card for the recent buyer — max() must win, not the latest row.
  await createPunchCard(db, resolver, { customerId: recent.id, now: day(6) });
  const { results } = await listCustomers(db, { sort: 'lastPurchase' });
  assert.deepEqual(
    results.map((r) => r.lastName),
    ['טרייה', 'מזמן', 'רכישות'],
  );
  assert.equal(results[0]?.lastPurchaseAt, day(15).toISOString());
  assert.equal(results[2]?.lastPurchaseAt, null);
});

test('status filter narrows to the requested status', async () => {
  const db = await freshDb();
  await seedCustomer(db, 'רגילה', 'א', day(1));
  await seedCustomer(db, 'חשובה', 'ב', day(2), { status: 'vip' });
  await seedCustomer(db, 'קפואה', 'ג', day(3), { status: 'frozen' });
  const vip = await listCustomers(db, { status: 'vip' });
  assert.equal(vip.total, 1);
  assert.equal(vip.results[0]?.firstName, 'חשובה');
  const frozen = await listCustomers(db, { status: 'frozen' });
  assert.equal(frozen.total, 1);
  assert.equal(frozen.results[0]?.firstName, 'קפואה');
});

test('hasActiveCard=true keeps only holders of an ACTIVE card (cancelled does not count)', async () => {
  const db = await freshDb();
  const holder = await seedCustomer(db, 'עם', 'כרטיסייה', day(1));
  const cancelled = await seedCustomer(db, 'ביטלה', 'כרטיסייה', day(2));
  await seedCustomer(db, 'בלי', 'כלום', day(3));
  await createPunchCard(db, resolver, { customerId: holder.id, now: day(4) });
  const card = await createPunchCard(db, resolver, { customerId: cancelled.id, now: day(4) });
  const res = await cancelCard(db, { cardId: card.id, reason: 'לקוחה ביקשה לבטל את הכרטיסייה' });
  assert.equal(res.ok, true);

  const withCard = await listCustomers(db, { hasActiveCard: true });
  assert.equal(withCard.total, 1);
  assert.equal(withCard.results[0]?.firstName, 'עם');

  const withoutCard = await listCustomers(db, { hasActiveCard: false, sort: 'oldest' });
  assert.equal(withoutCard.total, 2);
  assert.deepEqual(
    withoutCard.results.map((r) => r.firstName),
    ['ביטלה', 'בלי'],
  );
});

test('q matches name, phone, customer number, and email', async () => {
  const db = await freshDb();
  const noa = await seedCustomer(db, 'נועה', 'כהן', day(1), { email: 'noa@example.com' });
  await seedCustomer(db, 'רוני', 'לוי', day(2));
  for (const q of ['נועה', noa.phone.slice(-4), noa.customerNumber, 'noa@example']) {
    const { results, total } = await listCustomers(db, { q });
    assert.equal(total, 1, `q=${q}`);
    assert.equal(results[0]?.id, noa.id, `q=${q}`);
  }
});

test('q with a full name matches across first + last columns (token AND)', async () => {
  const db = await freshDb();
  const noa = await seedCustomer(db, 'נועה', 'כהן', day(1));
  await seedCustomer(db, 'נועה', 'לוי', day(2));
  await seedCustomer(db, 'דנה', 'כהן', day(3));
  const { results, total } = await listCustomers(db, { q: 'נועה כהן' });
  assert.equal(total, 1);
  assert.equal(results[0]?.id, noa.id);
});

test('q composes with status filter', async () => {
  const db = await freshDb();
  await seedCustomer(db, 'נועה', 'רגילה', day(1));
  const vip = await seedCustomer(db, 'נועה', 'חשובה', day(2), { status: 'vip' });
  const { results, total } = await listCustomers(db, { q: 'נועה', status: 'vip' });
  assert.equal(total, 1);
  assert.equal(results[0]?.id, vip.id);
});

test('limit/offset paginate without overlap and total counts all matches', async () => {
  const db = await freshDb();
  for (let i = 1; i <= 7; i += 1) {
    await seedCustomer(db, `לקוחה${String(i).padStart(2, '0')}`, 'בדיקה', day(i));
  }
  const page1 = await listCustomers(db, { sort: 'oldest', limit: 3, offset: 0 });
  const page2 = await listCustomers(db, { sort: 'oldest', limit: 3, offset: 3 });
  const page3 = await listCustomers(db, { sort: 'oldest', limit: 3, offset: 6 });
  assert.equal(page1.total, 7);
  assert.equal(page2.total, 7);
  assert.deepEqual(
    [...page1.results, ...page2.results, ...page3.results].map((r) => r.firstName),
    [1, 2, 3, 4, 5, 6, 7].map((i) => `לקוחה${String(i).padStart(2, '0')}`),
  );
});

test('limit is clamped to the 100 max and offset below 0 is treated as 0', async () => {
  const db = await freshDb();
  await seedCustomer(db, 'אחת', 'ויחידה', day(1));
  const { results } = await listCustomers(db, { limit: 5000, offset: -10 });
  assert.equal(results.length, 1);
});
