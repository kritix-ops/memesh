import { apiRequest, type ApiResult } from '@memesh/web-shared';

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

// ---------------------------------------------------------------------------
// Live operational dashboard — mirrors DashboardLiveResponse in
// apps/api/src/routes/admin.ts. Consumed by the LiveRoundsDashboard component
// on the admin landing. Server gates role + revenue; the client never
// role-checks and infers "revenue hidden" from `revenueIls === undefined`.
// ---------------------------------------------------------------------------

export interface DashboardLiveSettings {
  refreshIntervalSeconds: number;
  showWeekAhead: boolean;
  capacityWarningPct: number;
  capacityDangerPct: number;
}

export interface DashboardLiveStats {
  /** Absent when revenue is gated off or the requester role is below manager. */
  revenueIls?: number;
  /** Day-over-day delta at the same hour; null when yesterday has no data point. Absent under the same gate as revenueIls. */
  revenueDeltaPct?: number | null;
  bookingsCount: number;
  bookingsDelta: number | null;
  activeHoldsCount: number;
  punchCardsSold: number;
  punchCardsDelta: number | null;
}

export interface DashboardLiveRound {
  roundInstanceId: string;
  label: string;
  /** "HH:MM" local time. */
  startTime: string;
  endTime: string;
  capacity: number;
  /** confirmed + used + active holds */
  taken: number;
  heldCount: number;
  /** 0..100, rounded. */
  pctFull: number;
  isClosed: boolean;
}

export type DashboardLiveAlertKind =
  | 'payment_received_no_slot'
  | 'stuck_hold'
  | 'round_full_growing_waitlist';

export interface DashboardLiveAlert {
  id: string;
  kind: DashboardLiveAlertKind;
  /** Pre-rendered Hebrew, server-localized. First-name + last-initial only, no PII. */
  message: string;
  contextHref: string;
  occurredAt: string;
}

export interface DashboardLiveWaitlist {
  roundInstanceId: string;
  label: string;
  waitingCount: number;
  lastNotifiedAt: string | null;
}

export interface DashboardLiveWeekAheadRound {
  /** null when the round does NOT run on this date. */
  roundInstanceId: string | null;
  label: string;
  startTime: string;
  /** null when roundInstanceId is null. */
  pctFull: number | null;
  isClosed: boolean;
}

export interface DashboardLiveWeekAheadDay {
  /** YYYY-MM-DD */
  date: string;
  rounds: DashboardLiveWeekAheadRound[];
}

export interface DashboardLiveResponse {
  asOf: string;
  settings: DashboardLiveSettings;
  today: {
    rounds: DashboardLiveRound[];
    stats: DashboardLiveStats;
  };
  /** Empty when nothing is wrong — the UI hides the whole zone. */
  alerts: DashboardLiveAlert[];
  /** Empty when no rounds today have waitlist activity. */
  waitlist: DashboardLiveWaitlist[];
  weekAhead: DashboardLiveWeekAheadDay[];
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
  | 'update_card_settings'
  | 'refund_entry'
  | 'reassign_card'
  | 'edit_card'
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

export const getDashboardLive = (): Promise<ApiResult<DashboardLiveResponse>> =>
  apiRequest('/admin/dashboard/live');

export const getDormantCustomers = (): Promise<ApiResult<DormantResponse>> =>
  apiRequest('/admin/reports/dormant');

export const listStaffActions = (): Promise<ApiResult<ActionsResponse>> =>
  apiRequest('/admin/actions');
