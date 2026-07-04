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
  /** Real bookings: confirmed + used (holds excluded). */
  bookedCount: number;
  /** Checked in at the door. */
  arrivedCount: number;
  pctFull: number;
  isClosed: boolean;
}

export interface RoundAttendee {
  bookingId: string;
  firstName: string;
  lastName: string;
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  arrived: boolean;
  usedAt: string | null;
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
  /** The calendar date this response describes (YYYY-MM-DD). */
  date: string;
  settings: StaffRoundsSettings;
  rounds: StaffRoundsRound[];
  /** Populated for today only. */
  waitlist: StaffRoundsWaitlist[];
}

/** No date = today. Any YYYY-MM-DD reads that day (floor verification of future bookings). */
export const getStaffRounds = (date?: string): Promise<ApiResult<StaffRoundsResponse>> =>
  apiRequest(`/staff/rounds/today${date ? `?date=${encodeURIComponent(date)}` : ''}`);

/** Booked customers of a round with arrival status — the "מי הגיע" list. */
export const getRoundAttendees = (
  roundInstanceId: string,
): Promise<ApiResult<{ attendees: RoundAttendee[] }>> =>
  apiRequest(`/staff/rounds/${roundInstanceId}/attendees`);
