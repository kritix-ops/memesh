import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Mirrors apps/api/src/routes/staff-rounds.ts. Read-only rounds status for the
// shift floor — occupancy + waitlist counts only, never revenue or PII.

export interface StaffRoundsRound {
  roundInstanceId: string;
  label: string;
  startTime: string;
  endTime: string;
  capacity: number;
  taken: number;
  pctFull: number;
  isClosed: boolean;
}

export interface StaffRoundsWaitlist {
  roundInstanceId: string;
  label: string;
  waitingCount: number;
}

export interface StaffRoundsSettings {
  refreshIntervalSeconds: number;
  capacityWarningPct: number;
  capacityDangerPct: number;
}

export interface StaffRoundsResponse {
  asOf: string;
  settings: StaffRoundsSettings;
  rounds: StaffRoundsRound[];
  waitlist: StaffRoundsWaitlist[];
}

export const getStaffRoundsToday = (): Promise<ApiResult<StaffRoundsResponse>> =>
  apiRequest('/staff/rounds/today');
