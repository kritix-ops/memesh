import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createStaff } from './accounts';
import {
  cleanupStaffPasswordResets,
  consumeStaffPasswordReset,
  countActiveStaffPasswordResets,
  invalidateStaffPasswordResets,
  mintStaffPasswordReset,
} from './staff-password-resets';

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

async function seedStaff(db: Awaited<ReturnType<typeof freshDb>>, email: string | undefined) {
  return createStaff(db, {
    firstName: 'Test',
    lastName: 'Staff',
    phone: phone(),
    passwordHash: 'scrypt$32768$8$1$abc$def',
    role: 'admin',
    ...(email !== undefined && { email }),
  });
}

test('mint + consume happy path returns the staff id', async () => {
  const db = await freshDb();
  const s = await seedStaff(db, 'admin@example.com');

  const minted = await mintStaffPasswordReset(db, { staffId: s.id });
  assert.ok(minted.raw);
  assert.equal(minted.hash.length, 64);
  assert.ok(minted.expiresAt.getTime() > Date.now());

  const result = await consumeStaffPasswordReset(db, minted.raw);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.staffId, s.id);
  }
});

test('second consume on the same token returns invalid_or_consumed', async () => {
  const db = await freshDb();
  const s = await seedStaff(db, 'admin2@example.com');
  const minted = await mintStaffPasswordReset(db, { staffId: s.id });

  const first = await consumeStaffPasswordReset(db, minted.raw);
  assert.equal(first.ok, true);

  const second = await consumeStaffPasswordReset(db, minted.raw);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, 'invalid_or_consumed');
  }
});

test('expired token returns expired even when row exists', async () => {
  const db = await freshDb();
  const s = await seedStaff(db, 'admin3@example.com');
  // TTL in the past — token is born already expired
  const minted = await mintStaffPasswordReset(db, {
    staffId: s.id,
    ttlMs: -1000,
    now: new Date(),
  });
  const result = await consumeStaffPasswordReset(db, minted.raw);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'expired');
  }
});

test('unknown token returns invalid_or_consumed', async () => {
  const db = await freshDb();
  const result = await consumeStaffPasswordReset(db, 'this-token-was-never-minted');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'invalid_or_consumed');
  }
});

test('invalidateStaffPasswordResets burns every outstanding token for the staff member', async () => {
  const db = await freshDb();
  const s = await seedStaff(db, 'admin4@example.com');

  const a = await mintStaffPasswordReset(db, { staffId: s.id });
  const b = await mintStaffPasswordReset(db, { staffId: s.id });
  const c = await mintStaffPasswordReset(db, { staffId: s.id });

  const { invalidated } = await invalidateStaffPasswordResets(db, s.id);
  assert.equal(invalidated, 3);

  for (const t of [a, b, c]) {
    const result = await consumeStaffPasswordReset(db, t.raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid_or_consumed');
    }
  }
});

test('countActiveStaffPasswordResets only counts unconsumed + unexpired rows', async () => {
  const db = await freshDb();
  const s = await seedStaff(db, 'admin5@example.com');

  await mintStaffPasswordReset(db, { staffId: s.id });
  await mintStaffPasswordReset(db, { staffId: s.id });
  // an expired one shouldn't count
  await mintStaffPasswordReset(db, { staffId: s.id, ttlMs: -1000 });

  const count = await countActiveStaffPasswordResets(db, s.id);
  assert.equal(count, 2);
});

test('cleanupStaffPasswordResets deletes only rows past the retention window', async () => {
  const db = await freshDb();
  const s = await seedStaff(db, 'admin6@example.com');

  const now = new Date('2026-06-21T12:00:00Z');
  // Long-expired: created 30 days ago, expired 30 days ago - past retention.
  await mintStaffPasswordReset(db, {
    staffId: s.id,
    ttlMs: 1000,
    now: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
  });
  // Fresh: still within TTL.
  await mintStaffPasswordReset(db, { staffId: s.id, now });

  const { deleted } = await cleanupStaffPasswordResets(db, { now });
  assert.equal(deleted, 1);

  const remaining = await countActiveStaffPasswordResets(db, s.id, now);
  assert.equal(remaining, 1);
});
