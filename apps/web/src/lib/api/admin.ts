import { apiRequest, type ApiResult } from '../api';

// Mirrors apps/api/src/routes/admin.ts response shapes. The admin endpoints
// are gated server-side (admin or manager); the client never role-checks.

export interface DashboardStats {
  entriesLast24h: number;
  entriesLast7d: number;
  entriesLast30d: number;
  cardsSoldLast30d: number;
  expiringIn30d: number;
  newCustomersLast7d: number;
}

export interface DashboardResponse {
  stats: DashboardStats;
}

export interface DormantCustomer {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  lastVisit: string | null;
}

export interface DormantResponse {
  customers: DormantCustomer[];
}

// Mirrors packages/db/src/actions.ts StaffActionType.
export type StaffActionType =
  | 'punch'
  | 'sell_card'
  | 'cancel_card'
  | 'register_customer'
  | 'create_staff'
  | 'other';

export interface StaffActionRow {
  id: string;
  action: StaffActionType;
  summary: string;
  createdAt: string;
  staffId: string | null;
  staffFirstName: string | null;
  staffLastName: string | null;
}

export interface ActionsResponse {
  actions: StaffActionRow[];
}

export const getDashboardStats = (): Promise<ApiResult<DashboardResponse>> =>
  apiRequest('/admin/dashboard');

export const getDormantCustomers = (): Promise<ApiResult<DormantResponse>> =>
  apiRequest('/admin/reports/dormant');

export const listStaffActions = (): Promise<ApiResult<ActionsResponse>> =>
  apiRequest('/admin/actions');
