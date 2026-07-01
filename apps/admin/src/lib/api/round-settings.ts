import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Admin client for the rounds operational settings singleton (super-brief §15).
// Mirrors apps/api/src/routes/round-settings.ts.

export interface RoundSettings {
  holdTtlMinutes: number;
  cancellationWindowHours: number;
  claimWindowMinutes: number;
  activeHoursStart: number;
  activeHoursEnd: number;
  reminderOffsets: number[];
  /** 'HH:MM:SS' from the DB time column. */
  closingTime: string;
  skipLastRoundReminder: boolean;
  updatedAt: string;
}

export interface RoundSettingsResponse {
  settings: RoundSettings;
}

export type RoundSettingsPatch = {
  holdTtlMinutes?: number;
  cancellationWindowHours?: number;
  claimWindowMinutes?: number;
  activeHoursStart?: number;
  activeHoursEnd?: number;
  reminderOffsets?: number[];
  closingTime?: string;
  skipLastRoundReminder?: boolean;
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
