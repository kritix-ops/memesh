import { type StaffRole } from '@memesh/staff-auth';
import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Mirrors apps/api/src/routes/role-permissions.ts. List is gated by admin or
// manager; the mutations are admin-only. The matrix is fetched whole and
// rendered as a category-grouped grid in the Staff > הרשאות tab.

export interface PermissionDescriptor {
  key: string;
  category: string;
  categoryLabel: string;
  label: string;
  description?: string;
}

export type GrantsMatrix = Record<StaffRole, Record<string, boolean>>;

export interface RolePermissionsResponse {
  permissions: PermissionDescriptor[];
  roles: StaffRole[];
  grants: GrantsMatrix;
}

/** Fetch the full role × permission matrix. */
export const fetchRolePermissions = (): Promise<ApiResult<RolePermissionsResponse>> =>
  apiRequest('/role-permissions');

/** Toggle one (role, permission) tuple. Admin only. */
export const updateRolePermission = (
  role: StaffRole,
  permission: string,
  granted: boolean,
): Promise<ApiResult<{ row: unknown }>> =>
  apiRequest(`/role-permissions/${role}/${permission}`, {
    method: 'PUT',
    body: { granted },
  });

/** Reset a non-admin role's grants back to the seeded defaults. */
export const resetRolePermissions = (
  role: StaffRole,
): Promise<ApiResult<{ grants: GrantsMatrix }>> =>
  apiRequest(`/role-permissions/${role}/reset`, { method: 'POST' });
