import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { listCustomers } from './customer-directory';
import { customersReport } from './reports';
import { customers } from './schema';
import {
  getOrCreateWalkInCustomerId,
  WALKIN_SENTINEL_CUSTOMER_NUMBER,
  WALKIN_SENTINEL_PHONE,
} from './walkin-customer';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

test('getOrCreateWalkInCustomerId creates the sentinel once and is idempotent', async () => {
  const db = await freshDb();
  const first = await getOrCreateWalkInCustomerId(db);
  const second = await getOrCreateWalkInCustomerId(db);
  assert.equal(first, second);

  // Exactly one sentinel row, carrying the reserved marker fields.
  const rows = await db.select().from(customers).where(eq(customers.phone, WALKIN_SENTINEL_PHONE));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, first);
  assert.equal(rows[0]!.customerNumber, WALKIN_SENTINEL_CUSTOMER_NUMBER);

  // ...but it never shows up in the browsable directory.
  const all = await listCustomers(db, { limit: 100 });
  assert.equal(all.total, 0);
});

test('the walk-in sentinel is hidden from the customer directory and search', async () => {
  const db = await freshDb();
  await getOrCreateWalkInCustomerId(db);
  const real = await createCustomer(db, {
    firstName: 'נועה',
    lastName: 'כהן',
    phone: '0501112233',
  });

  const browse = await listCustomers(db, {});
  assert.equal(browse.total, 1);
  assert.equal(browse.results.length, 1);
  assert.equal(browse.results[0]!.id, real.id);
  assert.ok(browse.results.every((c) => c.phone !== WALKIN_SENTINEL_PHONE));
  assert.ok(browse.results.every((c) => c.customerNumber !== WALKIN_SENTINEL_CUSTOMER_NUMBER));

  // Searching the sentinel's own name must not surface it either.
  const search = await listCustomers(db, { q: 'כניסה' });
  assert.equal(search.total, 0);
});

test('the walk-in sentinel is hidden from the customers report', async () => {
  const db = await freshDb();
  await getOrCreateWalkInCustomerId(db);
  const real = await createCustomer(db, { firstName: 'דני', lastName: 'לוי', phone: '0504445566' });

  const rows = await customersReport(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, real.id);
  assert.ok(rows.every((r) => r.phone !== WALKIN_SENTINEL_PHONE));
});
