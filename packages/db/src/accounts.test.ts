import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createStaff, getCustomerById, listStaff, updateCustomerProfile } from './accounts';
import { createCustomer } from './cards';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

let seq = 0;
const phone = () => {
  seq += 1;
  return `050-700-${String(seq).padStart(4, '0')}`;
};

test('createStaff stores a member and never returns the password hash', async () => {
  const db = await freshDb();
  const created = await createStaff(db, {
    firstName: 'Maya',
    lastName: 'Barak',
    phone: phone(),
    passwordHash: 'scrypt$32768$8$1$abc$def',
    role: 'manager',
  });
  assert.equal(created.role, 'manager');
  assert.equal(created.isActive, true);
  assert.equal('passwordHash' in created, false);
});

test('listStaff returns members without password hashes', async () => {
  const db = await freshDb();
  await createStaff(db, {
    firstName: 'Shani',
    lastName: 'Dahan',
    phone: phone(),
    passwordHash: 'scrypt$1$2$3$x$y',
    role: 'cashier',
  });
  const all = await listStaff(db);
  assert.equal(all.length, 1);
  assert.equal('passwordHash' in (all[0] ?? {}), false);
});

test('updateCustomerProfile edits allowed fields and leaves phone unchanged', async () => {
  const db = await freshDb();
  const p = phone();
  const customer = await createCustomer(db, { firstName: 'Noa', lastName: 'Cohen', phone: p });

  const updated = await updateCustomerProfile(db, customer.id, {
    firstName: 'Noa-Updated',
    email: 'noa@example.com',
    preferredChannel: 'whatsapp',
    children: [{ name: 'Itamar', dob: '2021-04-12' }],
  });

  assert.ok(updated);
  assert.equal(updated.firstName, 'Noa-Updated');
  assert.equal(updated.email, 'noa@example.com');
  assert.equal(updated.preferredChannel, 'whatsapp');
  assert.equal(updated.children.length, 1);
  assert.equal(updated.phone, p); // phone is not editable here
});

test('getCustomerById returns the customer or undefined', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Tamar',
    lastName: 'Levi',
    phone: phone(),
  });
  const found = await getCustomerById(db, customer.id);
  assert.ok(found);
  assert.equal(found.id, customer.id);
  const missing = await getCustomerById(db, '00000000-0000-0000-0000-000000000000');
  assert.equal(missing, undefined);
});
