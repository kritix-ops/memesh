// @memesh/db's package entry constructs a pg pool from DATABASE_URL at import
// time, so set it before importing (the pool is lazy; tests use a PGlite db).
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { WpClient, WpUserInput } from './wp-client';

const { createCustomer, getCustomerById } = await import('@memesh/db');
const { syncCustomerToWp } = await import('./wp-sync.js');

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder });
  return db;
}

test('syncCustomerToWp creates a WP user and stores wp_user_id', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Noa',
    lastName: 'Cohen',
    phone: '052-111-2222',
  });

  let captured: WpUserInput | undefined;
  const client: WpClient = {
    createUser: async (input) => {
      captured = input;
      return { id: 4242 };
    },
  };

  await syncCustomerToWp(client, db, customer);

  const updated = await getCustomerById(db, customer.id);
  assert.equal(updated?.wpUserId, 4242);
  assert.equal(captured?.username, '052-111-2222');
  assert.deepEqual(captured?.roles, ['subscriber']);
  assert.ok((captured?.password.length ?? 0) > 0);
});

test('syncCustomerToWp skips when the customer is already linked', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Dana',
    lastName: 'Levi',
    phone: '052-333-4444',
  });

  let called = false;
  const client: WpClient = {
    createUser: async () => {
      called = true;
      return { id: 1 };
    },
  };

  await syncCustomerToWp(client, db, { ...customer, wpUserId: 99 });
  assert.equal(called, false);
});
