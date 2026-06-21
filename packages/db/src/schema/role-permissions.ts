import { boolean, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { staff, staffRoleEnum } from './staff';

// Role-level capability grants. One row per (role, permission) tuple. The
// permission catalog itself lives in code (../permissions-catalog.ts) so that
// adding a capability is a pure code change plus a one-line INSERT in the
// migration that defines it. Read by the API permission guard and toggled by
// admins from the team-management screen.
//
// `admin` rows are seeded as a courtesy and shown in the UI, but the guard
// short-circuits the admin role to always-allowed regardless of what the DB
// holds — that is the lock-out safety net (rule 13).
export const rolePermissions = pgTable(
  'role_permissions',
  {
    role: staffRoleEnum('role').notNull(),
    permission: varchar('permission', { length: 64 }).notNull(),
    granted: boolean('granted').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Whoever flipped this row last, for the audit trail. SET NULL on staff
    // deletion so we never block a staff hard-delete on permission history.
    updatedBy: uuid('updated_by').references(() => staff.id, { onDelete: 'set null' }),
  },
  (table) => [primaryKey({ columns: [table.role, table.permission] })],
);

export type RolePermissionRow = typeof rolePermissions.$inferSelect;
export type NewRolePermissionRow = typeof rolePermissions.$inferInsert;
