import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createStaff } from './accounts';
import { PERMISSIONS } from './permissions-catalog';
import {
  getAllRolePermissions,
  getRolePermissions,
  isPermissionGranted,
  resetRoleToDefaults,
  setRolePermission,
} from './role-permissions';

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

const seedAdmin = async (db: Awaited<ReturnType<typeof freshDb>>) =>
  createStaff(db, {
    firstName: 'Yoav',
    lastName: 'Admin',
    phone: phone(),
    passwordHash: 'scrypt$1$2$3$x$y',
    role: 'admin',
  });

test('seed migration fills every catalog permission for every role', async () => {
  const db = await freshDb();
  const matrix = await getAllRolePermissions(db);

  for (const descriptor of PERMISSIONS) {
    assert.ok(
      descriptor.key in matrix.admin,
      `admin missing seeded grant for ${descriptor.key}`,
    );
    assert.ok(
      descriptor.key in matrix.manager,
      `manager missing seeded grant for ${descriptor.key}`,
    );
    assert.ok(
      descriptor.key in matrix.cashier,
      `cashier missing seeded grant for ${descriptor.key}`,
    );
    // Admin column is always-true regardless of catalog defaults.
    assert.equal(matrix.admin[descriptor.key], true);
  }
});

test('seed defaults match the catalog for manager and cashier', async () => {
  const db = await freshDb();
  const matrix = await getAllRolePermissions(db);

  for (const descriptor of PERMISSIONS) {
    assert.equal(
      matrix.manager[descriptor.key],
      descriptor.defaults.manager,
      `manager default mismatch for ${descriptor.key}`,
    );
    assert.equal(
      matrix.cashier[descriptor.key],
      descriptor.defaults.cashier,
      `cashier default mismatch for ${descriptor.key}`,
    );
  }
});

test('setRolePermission upserts and the matrix reflects the change', async () => {
  const db = await freshDb();
  const admin = await seedAdmin(db);

  await setRolePermission(db, {
    role: 'cashier',
    permission: 'cards.cancel',
    granted: true,
    updatedBy: admin.id,
  });

  const matrix = await getAllRolePermissions(db);
  assert.equal(matrix.cashier['cards.cancel'], true);

  // Flip it back to verify update path (not just insert).
  await setRolePermission(db, {
    role: 'cashier',
    permission: 'cards.cancel',
    granted: false,
    updatedBy: admin.id,
  });
  const after = await getAllRolePermissions(db);
  assert.equal(after.cashier['cards.cancel'], false);
});

test('setRolePermission refuses to touch the admin role', async () => {
  const db = await freshDb();
  const admin = await seedAdmin(db);

  await assert.rejects(
    () =>
      setRolePermission(db, {
        role: 'admin',
        permission: 'staff.delete',
        granted: false,
        updatedBy: admin.id,
      }),
    /admin role is locked/,
  );
});

test('setRolePermission rejects an unknown permission key', async () => {
  const db = await freshDb();
  const admin = await seedAdmin(db);
  await assert.rejects(
    () =>
      setRolePermission(db, {
        role: 'manager',
        permission: 'totally.fake',
        granted: true,
        updatedBy: admin.id,
      }),
    /unknown permission key/,
  );
});

test('isPermissionGranted returns admin as always-true and unknown as false', async () => {
  const db = await freshDb();
  assert.equal(await isPermissionGranted(db, 'admin', 'staff.delete'), true);
  // Even an unknown key returns true for admin (admin short-circuits before
  // catalog validation — there is no risk of escalation).
  assert.equal(await isPermissionGranted(db, 'admin', 'totally.fake'), true);
  assert.equal(await isPermissionGranted(db, 'cashier', 'totally.fake'), false);
});

test('isPermissionGranted reflects seeded defaults for non-admin roles', async () => {
  const db = await freshDb();
  // manager.view = true by default; cashier.staff.view = false.
  assert.equal(await isPermissionGranted(db, 'manager', 'staff.view'), true);
  assert.equal(await isPermissionGranted(db, 'cashier', 'staff.view'), false);
});

test('getRolePermissions for admin returns every catalog entry as true', async () => {
  const db = await freshDb();
  const grants = await getRolePermissions(db, 'admin');
  for (const descriptor of PERMISSIONS) {
    assert.equal(grants[descriptor.key], true, `admin missing ${descriptor.key}`);
  }
});

test('resetRoleToDefaults snaps a role back to the seeded matrix', async () => {
  const db = await freshDb();
  const admin = await seedAdmin(db);

  // Hand-edit a few grants for the cashier.
  await setRolePermission(db, {
    role: 'cashier',
    permission: 'cards.cancel',
    granted: true,
    updatedBy: admin.id,
  });
  await setRolePermission(db, {
    role: 'cashier',
    permission: 'punches.create',
    granted: false,
    updatedBy: admin.id,
  });

  const before = await getAllRolePermissions(db);
  assert.equal(before.cashier['cards.cancel'], true);
  assert.equal(before.cashier['punches.create'], false);

  await resetRoleToDefaults(db, 'cashier', admin.id);

  const after = await getAllRolePermissions(db);
  assert.equal(after.cashier['cards.cancel'], false, 'cashier.cards.cancel should be back to default false');
  assert.equal(after.cashier['punches.create'], true, 'cashier.punches.create should be back to default true');
});

test('resetRoleToDefaults refuses the admin role', async () => {
  const db = await freshDb();
  const admin = await seedAdmin(db);
  await assert.rejects(
    () => resetRoleToDefaults(db, 'admin', admin.id),
    /admin role is locked/,
  );
});
