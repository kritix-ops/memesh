import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Admin client for the rounds operational settings singleton (super-brief §15).
// Mirrors apps/api/src/routes/round-settings.ts.

export interface RoundSettings {
  /** Master switch — off means rounds are never mandatory anywhere. */
  roundsEnabled: boolean;
  holdTtlMinutes: number;
  cancellationWindowHours: number;
  claimWindowMinutes: number;
  activeHoursStart: number;
  activeHoursEnd: number;
  reminderOffsets: number[];
  /** 'HH:MM:SS' from the DB time column. */
  closingTime: string;
  skipLastRoundReminder: boolean;
  /** Staff/admin walk-ins may exceed a full round's capacity. */
  allowOverCapacityWalkIn: boolean;
  /** Warn the cashier at the door about the card's upcoming reserved rounds. */
  warnUpcomingReservationAtDoor: boolean;
  updatedAt: string;
}

export interface RoundSettingsResponse {
  settings: RoundSettings;
}

export type RoundSettingsPatch = {
  roundsEnabled?: boolean;
  holdTtlMinutes?: number;
  cancellationWindowHours?: number;
  claimWindowMinutes?: number;
  activeHoursStart?: number;
  activeHoursEnd?: number;
  reminderOffsets?: number[];
  closingTime?: string;
  skipLastRoundReminder?: boolean;
  allowOverCapacityWalkIn?: boolean;
  warnUpcomingReservationAtDoor?: boolean;
};

export interface RoundSettingsUpdateResponse {
  settings: RoundSettings;
  diff: Record<string, [unknown, unknown]>;
}

export const getRoundSettings = (): Promise<ApiResult<RoundSettingsResponse>> =>
  apiRequest('/admin/round-settings');

export const updateRoundSettings = (
  patch: RoundSettingsPatch,
): Promise<ApiResult<RoundSettingsUpdateResponse>> =>
  apiRequest('/admin/round-settings', { method: 'PATCH', body: patch });
