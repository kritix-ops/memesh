import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createStaff } from './accounts';
import {
  deleteStaffPin,
  generateRandomPin,
  getStaffPin,
  isStaffPinLocked,
  recordStaffPinFailure,
  recordStaffPinSuccess,
  setStaffPin,
  unlockStaffPin,
} from './staff-pins';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

type TestDb = Awaited<ReturnType<typeof freshDb>>;

const T0 = new Date('2026-06-20T10:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

let seq = 0;
async function seedCashier(db: TestDb) {
  seq += 1;
  return createStaff(db, {
    firstName: 'Cashier',
    lastName: `Number-${seq}`,
    phone: `050-700-${String(seq).padStart(4, '0')}`,
    passwordHash: 'scrypt$32768$8$1$AAAA$AAAA',
    role: 'cashier',
  });
}

test('generateRandomPin produces a string of the requested length, leading zeros included', () => {
  for (let i = 0; i < 200; i += 1) {
    const pin = generateRandomPin(3);
    assert.match(pin, /^\d{3}$/);
  }
  assert.match(generateRandomPin(6), /^\d{6}$/);
});

test('generateRandomPin rejects out-of-range length so a typo cannot ship a one-digit PIN', () => {
  assert.throws(() => generateRandomPin(2));
  assert.throws(() => generateRandomPin(13));
  assert.throws(() => generateRandomPin(0));
});

test('setStaffPin inserts a new row when none exists', async () => {
  const db = await freshDb();
  const cashier = await seedCashier(db);
  const row = await setStaffPin(db, {
    staffId: cashier.id,
    pinHash: 'scrypt$1024$8$1$AAAA$BBBB',
    now: T0,
  });
  assert.equal(row.staffId, cashier.id);
  assert.equal(row.failedCount, 0);
  assert.equal(row.lockedUntil, null);
});

test('setStaffPin upserts and resets lockout/failures on a rotate', async () => {
  const db = await freshDb();
  const cashier = await seedCashier(db);
  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h1', now: T0 });
  // Simulate accumulated failures and an active lockout.
  await recordStaffPinFailure(db, {
    staffId: cashier.id,
    maxFailures: 1,
    lockoutMinutes: 15,
    now: plus(1_000),
  });
  const before = await getStaffPin(db, cashier.id);
  assert.ok(before);
  assert.equal(before.failedCount, 1);
  assert.ok(before.lockedUntil);

  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h2', now: plus(2_000) });
  const after = await getStaffPin(db, cashier.id);
  assert.ok(after);
  assert.equal(after.pinHash, 'h2');
  assert.equal(after.failedCount, 0);
  assert.equal(after.lockedUntil, null);
});

test('recordStaffPinFailure increments and locks at the configured threshold', async () => {
  const db = await freshDb();
  const cashier = await seedCashier(db);
  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h1', now: T0 });

  // Threshold of 3 — first two are not yet locked, third triggers the lockout.
  const r1 = await recordStaffPinFailure(db, {
    staffId: cashier.id,
    maxFailures: 3,
    lockoutMinutes: 15,
    now: plus(1_000),
  });
  assert.equal(r1.failedCount, 1);
  assert.equal(r1.lockedUntil, null);

  const r2 = await recordStaffPinFailure(db, {
    staffId: cashier.id,
    maxFailures: 3,
    lockoutMinutes: 15,
    now: plus(2_000),
  });
  assert.equal(r2.failedCount, 2);
  assert.equal(r2.lockedUntil, null);

  const r3 = await recordStaffPinFailure(db, {
    staffId: cashier.id,
    maxFailures: 3,
    lockoutMinutes: 15,
    now: plus(3_000),
  });
  assert.equal(r3.failedCount, 3);
  assert.ok(r3.lockedUntil);
  // Lockout window is now + 15 min.
  assert.equal(r3.lockedUntil!.getTime(), plus(3_000).getTime() + 15 * 60 * 1000);
});

test('recordStaffPinSuccess resets the failure counter without touching the lockout window', async () => {
  const db = await freshDb();
  const cashier = await seedCashier(db);
  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h1', now: T0 });
  await recordStaffPinFailure(db, {
    staffId: cashier.id,
    maxFailures: 10,
    lockoutMinutes: 15,
    now: plus(1_000),
  });

  await recordStaffPinSuccess(db, cashier.id, plus(2_000));
  const row = await getStaffPin(db, cashier.id);
  assert.ok(row);
  assert.equal(row.failedCount, 0);
});

test('unlockStaffPin clears the lockout and the failure counter', async () => {
  const db = await freshDb();
  const cashier = await seedCashier(db);
  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h1', now: T0 });
  await recordStaffPinFailure(db, {
    staffId: cashier.id,
    maxFailures: 1,
    lockoutMinutes: 15,
    now: plus(1_000),
  });

  const ok = await unlockStaffPin(db, cashier.id, plus(2_000));
  assert.equal(ok, true);
  const row = await getStaffPin(db, cashier.id);
  assert.ok(row);
  assert.equal(row.failedCount, 0);
  assert.equal(row.lockedUntil, null);
});

test('deleteStaffPin removes the row, then setStaffPin can re-establish it', async () => {
  const db = await freshDb();
  const cashier = await seedCashier(db);
  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h1', now: T0 });

  const removed = await deleteStaffPin(db, cashier.id);
  assert.equal(removed, true);
  assert.equal(await getStaffPin(db, cashier.id), undefined);

  // No-op when there is nothing to delete.
  const removedAgain = await deleteStaffPin(db, cashier.id);
  assert.equal(removedAgain, false);

  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h2', now: plus(1_000) });
  const row = await getStaffPin(db, cashier.id);
  assert.ok(row);
  assert.equal(row.pinHash, 'h2');
});

test('isStaffPinLocked reflects the lockedUntil window', async () => {
  const db = await freshDb();
  const cashier = await seedCashier(db);
  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h1', now: T0 });

  // No failures yet → not locked.
  const fresh = await getStaffPin(db, cashier.id);
  assert.ok(fresh);
  assert.equal(isStaffPinLocked(fresh, T0), false);

  await recordStaffPinFailure(db, {
    staffId: cashier.id,
    maxFailures: 1,
    lockoutMinutes: 15,
    now: T0,
  });
  const locked = await getStaffPin(db, cashier.id);
  assert.ok(locked);
  assert.equal(isStaffPinLocked(locked, plus(1_000)), true);
  // After the window passes, the helper reports unlocked even before the
  // counter has been reset on disk.
  assert.equal(isStaffPinLocked(locked, plus(16 * 60 * 1000)), false);
});

test('deleting a staff cascades and removes the PIN row', async () => {
  const db = await freshDb();
  const cashier = await seedCashier(db);
  await setStaffPin(db, { staffId: cashier.id, pinHash: 'h1', now: T0 });
  // We don't expose a deleteStaff helper here — use the schema directly.
  const { staff } = await import('./schema/index');
  const { eq } = await import('drizzle-orm');
  await db.delete(staff).where(eq(staff.id, cashier.id));
  const row = await getStaffPin(db, cashier.id);
  assert.equal(row, undefined);
});
