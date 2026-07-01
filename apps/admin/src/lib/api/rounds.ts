import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Mirrors apps/api/src/routes/rounds-admin.ts. Admin-only management of round
// templates. Times are "HH:MM"; daysActive is a weekday bitmask (bit 0 = Sunday).

export interface AdminRound {
  id: string;
  label: string;
  displayName: string;
  startTime: string;
  endTime: string;
  daysActive: number;
  defaultCapacity: number;
  isActive: boolean;
  sortOrder: number;
  /** Materialized upcoming instances in the rolling window — list responses only. */
  upcomingInstances?: number;
}

export interface RoundsListResponse {
  rounds: AdminRound[];
}

export interface RoundInput {
  label: string;
  displayName: string;
  startTime: string;
  endTime: string;
  daysActive: number;
  defaultCapacity: number;
  isActive?: boolean;
  sortOrder?: number;
}

export type RoundPatch = Partial<RoundInput>;

export interface RoundResponse {
  round: AdminRound;
}

export const listRounds = (): Promise<ApiResult<RoundsListResponse>> => apiRequest('/admin/rounds');

export const createRound = (input: RoundInput): Promise<ApiResult<RoundResponse>> =>
  apiRequest('/admin/rounds', { method: 'POST', body: input });

export const updateRound = (id: string, patch: RoundPatch): Promise<ApiResult<RoundResponse>> =>
  apiRequest(`/admin/rounds/${id}`, { method: 'PATCH', body: patch });

export const deleteRound = (id: string): Promise<ApiResult<{ ok: true }>> =>
  apiRequest(`/admin/rounds/${id}`, { method: 'DELETE' });

export const duplicateRound = (id: string): Promise<ApiResult<RoundResponse>> =>
  apiRequest(`/admin/rounds/${id}/duplicate`, { method: 'POST' });

// --- Schedule rules (when the rounds system applies) -------------------------

export interface ScheduleWindow {
  /** "HH:MM" */
  start: string;
  end: string;
}

export interface ScheduleRule {
  id: string;
  dateFrom: string | null;
  dateTo: string | null;
  /** Bit 0 = Sunday … bit 6 = Saturday; null = every weekday. */
  weekdayMask: number | null;
  windows: ScheduleWindow[];
  /** What the day is outside the windows: tickets without a round, or nothing sold. */
  outside: 'free_play' | 'closed';
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRuleInput {
  dateFrom?: string | null;
  dateTo?: string | null;
  weekdayMask?: number | null;
  windows: ScheduleWindow[];
  outside: 'free_play' | 'closed';
  note?: string | null;
}

export const listScheduleRules = (): Promise<ApiResult<{ rules: ScheduleRule[] }>> =>
  apiRequest('/admin/rounds/schedule-rules');

export const createScheduleRule = (input: ScheduleRuleInput): Promise<ApiResult<{ rule: ScheduleRule }>> =>
  apiRequest('/admin/rounds/schedule-rules', { method: 'POST', body: input });

export const deleteScheduleRule = (id: string): Promise<ApiResult<{ ok: true }>> =>
  apiRequest(`/admin/rounds/schedule-rules/${id}`, { method: 'DELETE' });
