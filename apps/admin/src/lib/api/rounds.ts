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

export const listRoundOffDates = (): Promise<ApiResult<{ dates: string[] }>> =>
  apiRequest('/admin/rounds/off-dates');

export const addRoundOffDate = (date: string): Promise<ApiResult<{ dates: string[] }>> =>
  apiRequest('/admin/rounds/off-dates', { method: 'POST', body: { date } });

export const removeRoundOffDate = (date: string): Promise<ApiResult<{ dates: string[] }>> =>
  apiRequest(`/admin/rounds/off-dates/${date}`, { method: 'DELETE' });
