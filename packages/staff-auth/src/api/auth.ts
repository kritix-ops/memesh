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

/**
 * Sign in with email + password. Username moved from phone to email on
 * 2026-06-21 so a staff member's credential survives a phone change. Phone
 * is still in the schema as a unique contact id but no longer authenticates.
 */
export const staffLogin = (email: string, password: string): Promise<ApiResult<LoginResponse>> =>
  apiRequest('/auth/login', { method: 'POST', body: { email, password } });

export const staffMe = (): Promise<ApiResult<MeResponse>> => apiRequest('/auth/me');

export const staffLogout = (): Promise<ApiResult<{ ok: true }>> =>
  apiRequest('/auth/logout', { method: 'POST' });

/**
 * Request a password-reset link. The API always responds 200 { ok: true }
 * regardless of whether the email is on file — no enumeration. The caller
 * surfaces the same generic message on every result.
 */
export const staffForgotPassword = (email: string): Promise<ApiResult<{ ok: true }>> =>
  apiRequest('/auth/forgot-password', { method: 'POST', body: { email } });

/**
 * Consume a reset token and set a new password. Server rotates the password
 * hash AND burns every other outstanding reset token for the user, so a
 * leaked-but-unused token cannot be used after a legitimate reset.
 */
export const staffResetPassword = (
  token: string,
  newPassword: string,
): Promise<ApiResult<{ ok: true }>> =>
  apiRequest('/auth/reset-password', { method: 'POST', body: { token, newPassword } });
