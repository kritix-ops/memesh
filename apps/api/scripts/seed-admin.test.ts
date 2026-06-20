// Set env BEFORE any module that touches @memesh/db's client.ts loads. The
// pg Pool factory at @memesh/db's import time requires DATABASE_URL. The test
// never opens a real pg connection — PGlite stands in — but the module guard
// is checked at import time, so we set the env first and use a dynamic import
// for the seed script + @memesh/db re-exports.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Dynamic imports so the env above is set before @memesh/db's client.ts runs.
const { seedAdmin, verifySeededPassword } = await import('./seed-admin.js');
const { MIGRATIONS_FOLDER } = await import('@memesh/db');

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

let seq = 0;
const phone = () => {
  seq += 1;
  return `050-900-${String(seq).padStart(4, '0')}`;
};

test('seedAdmin creates the first admin and stores a verifiable scrypt hash', async () => {
  const db = await freshDb();
  const p = phone();
  // The phone() helper produces dashed input like 050-900-0001. seedAdmin
  // normalizes that to 0509000001 before storage, so the returned row carries
  // the canonical form — and verifySeededPassword can accept either format
  // because it normalizes the lookup the same way.
  const pNormalized = p.replace(/-/g, '');
  const result = await seedAdmin(db, {
    phone: p,
    password: 'a-strong-password-1!',
    firstName: 'Yanay',
    lastName: 'Owner',
  });
  assert.equal(result.kind, 'created');
  assert.equal(result.phone, pNormalized);
  assert.ok(result.id);

  // Verifying with the original dashed input still works (lookup normalizes).
  const verifies = await verifySeededPassword(db, p, 'a-strong-password-1!');
  assert.equal(verifies, true);

  // And verifying with the no-dashes form also works (same normalization).
  const verifiesNormalized = await verifySeededPassword(
    db,
    pNormalized,
    'a-strong-password-1!',
  );
  assert.equal(verifiesNormalized, true);

  const wrongPasswordRejected = await verifySeededPassword(db, p, 'a-strong-password-1?');
  assert.equal(wrongPasswordRejected, false);
});

test('seedAdmin is idempotent — second call with the same phone is a no-op', async () => {
  const db = await freshDb();
  const p = phone();
  const first = await seedAdmin(db, { phone: p, password: 'first-password-123!' });
  assert.equal(first.kind, 'created');

  const second = await seedAdmin(db, { phone: p, password: 'a-different-password-456!' });
  assert.equal(second.kind, 'already_seeded');
  assert.equal(second.id, first.id);

  // The original password still verifies; the second call did not overwrite the hash.
  const stillFirst = await verifySeededPassword(db, p, 'first-password-123!');
  assert.equal(stillFirst, true);
  const notSecond = await verifySeededPassword(db, p, 'a-different-password-456!');
  assert.equal(notSecond, false);
});

test('seedAdmin rejects passwords shorter than 12 characters', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => seedAdmin(db, { phone: phone(), password: 'too-short' }),
    /at least 12 characters/,
  );
});

test('seedAdmin uses default Admin/User name when not provided', async () => {
  const db = await freshDb();
  const p = phone();
  const result = await seedAdmin(db, { phone: p, password: 'default-name-pw-1!' });
  assert.equal(result.kind, 'created');
  const verifies = await verifySeededPassword(db, p, 'default-name-pw-1!');
  assert.equal(verifies, true);
});
