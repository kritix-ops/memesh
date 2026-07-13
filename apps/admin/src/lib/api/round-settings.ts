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
  /** How many days ahead a customer may register. */
  bookingHorizonDays: number;
  /** Minutes after a round ends that staff may still mark arrivals. */
  markingGraceMinutes: number;
  /** Interim: cancel frees the seat + emails staff to refund by hand. */
  manualRefundOnCancel: boolean;
  /** Where the manual-refund staff alert is sent (empty = none). */
  cancellationAlertEmail: string;
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
  bookingHorizonDays?: number;
  markingGraceMinutes?: number;
  manualRefundOnCancel?: boolean;
  cancellationAlertEmail?: string;
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
