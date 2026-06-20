import { apiRequest, type ApiResult } from '../api';
import { type StaffRole } from './auth';

// Mirrors apps/api/src/routes/staff.ts. The list endpoint is gated by
// admin or manager; the create endpoint is admin-only. The password hash
// is never returned from listStaff (server projects the safe view).

export interface StaffMember {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  role: StaffRole;
  isActive: boolean;
  createdAt: string;
}

export interface StaffListResponse {
  staff: StaffMember[];
}

export interface CreateStaffInput {
  firstName: string;
  lastName: string;
  phone: string;
  password: string;
  role?: StaffRole;
  email?: string;
}

export interface CreateStaffResponse {
  staff: StaffMember;
}

export const listStaff = (): Promise<ApiResult<StaffListResponse>> => apiRequest('/staff');

export const createStaffMember = (
  input: CreateStaffInput,
): Promise<ApiResult<CreateStaffResponse>> => apiRequest('/staff', { method: 'POST', body: input });

export interface UpdateStaffInput {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  role?: StaffRole;
  isActive?: boolean;
}

export interface UpdateStaffResponse {
  staff: StaffMember;
}

/**
 * Edit a staff member (admin only). Phone is intentionally not editable here
 * (it is the login identity); password updates need their own dedicated flow.
 */
export const updateStaffMember = (
  id: string,
  patch: UpdateStaffInput,
): Promise<ApiResult<UpdateStaffResponse>> =>
  apiRequest(`/staff/${id}`, { method: 'PATCH', body: patch });

/**
 * Hard-delete a staff member (admin only). Returns a structured error when
 * the row is still referenced by other tables (`has_dependents`), when the
 * caller would delete themselves (`cannot_delete_self`), or when the row
 * is the last active admin (`cannot_delete_last_admin`). The UI surfaces
 * those by name so the operator knows what to do (deactivate, log in as
 * someone else, promote another admin first).
 */
export const deleteStaffMember = (id: string): Promise<ApiResult<{ ok: true }>> =>
  apiRequest(`/staff/${id}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Cashier attribution PIN (Yanay 2026-06-20). Admin/manager manages PINs for
// every cashier; the cashier can also self-set via /me/pin with the
// fresh-auth password gate.
// ---------------------------------------------------------------------------

export interface StaffPinStatus {
  exists: boolean;
  locked: boolean;
  /** ISO timestamp when the lockout expires, or null when not locked. */
  lockedUntil: string | null;
  failedCount: number;
}

/** Read PIN status for a cashier (admin/manager only). */
export const getStaffPinStatus = (id: string): Promise<ApiResult<StaffPinStatus>> =>
  apiRequest(`/staff/${id}/pin`);

/** Set a specific PIN (digits, length matches the live settings.pinLength). */
export const setStaffPin = (
  id: string,
  pin: string,
): Promise<ApiResult<StaffPinStatus>> =>
  apiRequest(`/staff/${id}/pin`, { method: 'PUT', body: { pin } });

/**
 * Generate a random PIN of the configured length. The server returns the
 * generated PIN exactly once — the UI must surface it to the manager so they
 * can hand it to the cashier. There is no way to recover it after this call.
 */
export const generateStaffPin = (
  id: string,
): Promise<ApiResult<StaffPinStatus & { pin: string }>> =>
  apiRequest(`/staff/${id}/pin/generate`, { method: 'POST' });

/** Remove the cashier's PIN entirely. */
export const deleteStaffPin = (
  id: string,
): Promise<ApiResult<{ ok: true; removed: boolean }>> =>
  apiRequest(`/staff/${id}/pin`, { method: 'DELETE' });

/** Clear the lockout state on a cashier's PIN. */
export const unlockStaffPin = (id: string): Promise<ApiResult<StaffPinStatus>> =>
  apiRequest(`/staff/${id}/pin/unlock`, { method: 'POST' });

/** Read the signed-in cashier's own PIN status. */
export const getMyPinStatus = (): Promise<ApiResult<StaffPinStatus>> => apiRequest('/me/pin');

/**
 * Self-set the signed-in cashier's PIN. Server requires the current password
 * as a fresh-auth gate so a stolen session can't silently rotate the PIN.
 */
export const setMyPin = (
  pin: string,
  password: string,
): Promise<ApiResult<StaffPinStatus>> =>
  apiRequest('/me/pin', { method: 'PUT', body: { pin, password } });
