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
