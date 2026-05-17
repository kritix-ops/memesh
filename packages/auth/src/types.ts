// Keep in sync with packages/db/src/schema/users.ts userRoleEnum.
export const USER_ROLES = ['customer', 'cashier', 'instructor', 'manager', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AccessClaims {
  sub: string;
  role: UserRole;
  iat: number;
  exp: number;
  jti?: string;
  iss?: string;
  aud?: string | string[];
}

export interface RefreshClaims {
  sub: string;
  role: UserRole;
  typ: 'refresh';
  iat: number;
  exp: number;
  jti?: string;
  iss?: string;
  aud?: string | string[];
}
