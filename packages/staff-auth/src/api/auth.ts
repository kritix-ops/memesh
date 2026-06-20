import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Mirrors @memesh/auth's STAFF_ROLES. Kept local so apps/web doesn't have to
// import the auth package (which contains scrypt + jose — server-only code).
export type StaffRole = 'admin' | 'manager' | 'cashier';

export interface StaffUser {
  id: string;
  role: StaffRole;
  firstName: string;
  lastName: string;
  email: string | null;
}

export interface MeResponse {
  user: StaffUser | null;
}

export interface LoginResponse {
  role: StaffRole;
  // The API also returns accessToken + refreshToken in the body for non-browser
  // clients. The web app ignores them — auth is purely via HttpOnly cookies
  // that the browser sets and sends automatically.
  accessToken: string;
  refreshToken: string;
}

export const staffLogin = (phone: string, password: string): Promise<ApiResult<LoginResponse>> =>
  apiRequest('/auth/login', { method: 'POST', body: { phone, password } });

export const staffMe = (): Promise<ApiResult<MeResponse>> => apiRequest('/auth/me');

export const staffLogout = (): Promise<ApiResult<{ ok: true }>> =>
  apiRequest('/auth/logout', { method: 'POST' });
