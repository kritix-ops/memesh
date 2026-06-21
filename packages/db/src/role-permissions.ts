import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  defaultGrantFor,
  isKnownPermission,
  PERMISSIONS,
  STAFF_ROLES,
  type StaffRole,
} from './permissions-catalog';
import { rolePermissions } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

// Grants matrix returned to the API. Indexed first by role, then by permission
// key. The map is dense — every permission in the catalog is present for every
// role, falling back to the catalog default when the DB has no row (which only
// happens during the brief window after a catalog addition before the seed
// migration runs).
export type GrantsMatrix = Record<StaffRole, Record<string, boolean>>;

const emptyMatrix = (): GrantsMatrix => {
  const matrix = {} as GrantsMatrix;
  for (const role of STAFF_ROLES) {
    matrix[role] = {};
  }
  return matrix;
};

/**
 * Read every (role, permission) grant from the DB and merge with the static
 * catalog so the caller always sees a complete matrix. DB rows win when they
 * exist; missing rows fall back to the catalog default. Admin column is
 * forced to `true` for every catalog entry — the matrix is the source the
 * UI renders from, and the admin column must never appear partially granted
 * even if a stray DB row says otherwise.
 */
export const getAllRolePermissions = async (db: AnyPgDatabase): Promise<GrantsMatrix> => {
  const rows = await db.select().from(rolePermissions);
  const matrix = emptyMatrix();

  for (const descriptor of PERMISSIONS) {
    for (const role of STAFF_ROLES) {
      matrix[role][descriptor.key] = defaultGrantFor(role, descriptor.key);
    }
  }

  for (const row of rows) {
    if (!isKnownPermission(row.permission)) continue;
    matrix[row.role as StaffRole][row.permission] = row.granted;
  }

  // Admin is always granted everything in the catalog — see comment above.
  for (const descriptor of PERMISSIONS) {
    matrix.admin[descriptor.key] = true;
  }

  return matrix;
};

/**
 * Read the grants for a single role. Used by the permission guard's cache
 * loader. Same fallback semantics as getAllRolePermissions.
 */
export const getRolePermissions = async (
  db: AnyPgDatabase,
  role: StaffRole,
): Promise<Record<string, boolean>> => {
  if (role === 'admin') {
    const adminGrants: Record<string, boolean> = {};
    for (const descriptor of PERMISSIONS) adminGrants[descriptor.key] = true;
    return adminGrants;
  }

  const rows = await db.select().from(rolePermissions).where(eq(rolePermissions.role, role));
  const grants: Record<string, boolean> = {};

  for (const descriptor of PERMISSIONS) {
    grants[descriptor.key] = defaultGrantFor(role, descriptor.key);
  }
  for (const row of rows) {
    if (!isKnownPermission(row.permission)) continue;
    grants[row.permission] = row.granted;
  }
  return grants;
};

export interface SetRolePermissionInput {
  role: StaffRole;
  permission: string;
  granted: boolean;
  updatedBy: string;
}

/**
 * Insert-or-update a single (role, permission) grant. Refuses to touch the
 * admin role — that is the lock-out safety net. Throws on an unknown
 * permission key so a typo in the route layer never silently writes a
 * dead row that ghosts the catalog.
 */
export const setRolePermission = async (
  db: AnyPgDatabase,
  input: SetRolePermissionInput,
  now: Date = new Date(),
) => {
  if (input.role === 'admin') {
    throw new Error('[role-permissions] admin role is locked and cannot be modified');
  }
  if (!isKnownPermission(input.permission)) {
    throw new Error(`[role-permissions] unknown permission key: ${input.permission}`);
  }

  const rows = await db
    .insert(rolePermissions)
    .values({
      role: input.role,
      permission: input.permission,
      granted: input.granted,
      updatedAt: now,
      updatedBy: input.updatedBy,
    })
    .onConflictDoUpdate({
      target: [rolePermissions.role, rolePermissions.permission],
      set: { granted: input.granted, updatedAt: now, updatedBy: input.updatedBy },
    })
    .returning();
  return rows[0];
};

/**
 * Reset a single non-admin role's grants to the seeded defaults from the
 * catalog. Used by the "ברירת מחדל" button in the admin UI. Runs as one
 * statement per permission inside a transaction so a partial failure leaves
 * the role's grants consistent.
 */
export const resetRoleToDefaults = async (
  db: AnyPgDatabase,
  role: StaffRole,
  updatedBy: string,
  now: Date = new Date(),
) => {
  if (role === 'admin') {
    throw new Error('[role-permissions] admin role is locked and cannot be reset');
  }
  // Single statement: upsert every catalog entry to its default. Cheaper than
  // 28 individual round-trips and atomic without an explicit transaction
  // wrapper (single INSERT ... ON CONFLICT is atomic per row but here we want
  // them committed together; the values array below is one statement).
  const values = PERMISSIONS.map((descriptor) => ({
    role,
    permission: descriptor.key,
    granted: defaultGrantFor(role, descriptor.key),
    updatedAt: now,
    updatedBy,
  }));
  if (values.length === 0) return;

  await db
    .insert(rolePermissions)
    .values(values)
    .onConflictDoUpdate({
      target: [rolePermissions.role, rolePermissions.permission],
      set: {
        granted: sql`excluded.granted`,
        updatedAt: sql`excluded.updated_at`,
        updatedBy: sql`excluded.updated_by`,
      },
    });
};

/**
 * Best-effort check that a single (role, permission) tuple grants access.
 * The API uses an in-memory cache on top of this; tests use it directly.
 * Admin always returns true. Unknown permission keys return false (fail
 * closed for non-admins, per rule 13).
 */
export const isPermissionGranted = async (
  db: AnyPgDatabase,
  role: StaffRole,
  permission: string,
): Promise<boolean> => {
  if (role === 'admin') return true;
  if (!isKnownPermission(permission)) return false;
  const rows = await db
    .select({ granted: rolePermissions.granted })
    .from(rolePermissions)
    .where(and(eq(rolePermissions.role, role), eq(rolePermissions.permission, permission)))
    .limit(1);
  if (rows.length === 0) return defaultGrantFor(role, permission);
  return rows[0]?.granted ?? false;
};
