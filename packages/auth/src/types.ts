// Keep in sync with packages/db/src/schema/staff.ts staffRoleEnum.
// Customers do not get a staff role; they authenticate separately via phone + OTP.
export const STAFF_ROLES = ['admin', 'manager', 'cashier'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface AccessClaims {
  sub: string;
  role: StaffRole;
  iat: number;
  exp: number;
  jti?: string;
  iss?: string;
  aud?: string | string[];
}

export interface RefreshClaims {
  sub: string;
  role: StaffRole;
  typ: 'refresh';
  iat: number;
  exp: number;
  jti?: string;
  iss?: string;
  aud?: string | string[];
}
