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
  /** Active pre-payment holds — the "בתהליך תשלום" slice of `taken`. */
  heldCount: number;
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
  phone: string;
  email: string | null;
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

export interface StaffDayAvailability {
  /** YYYY-MM-DD */
  date: string;
  /** false = free play on this date — rounds (if any) are optional. */
  roundsRequired: boolean;
  /** An admin rule shut this day — nothing bookable, no free play. */
  closed: boolean;
  rounds: {
    roundInstanceId: string;
    label: string;
    startTime: string;
    endTime: string;
    capacity: number;
    available: number;
    isClosed: boolean;
  }[];
}

/** No date = today. Any YYYY-MM-DD reads that day (floor verification of future bookings). */
export const getStaffRounds = (date?: string): Promise<ApiResult<StaffRoundsResponse>> =>
  apiRequest(`/staff/rounds/today${date ? `?date=${encodeURIComponent(date)}` : ''}`);

/** Two weeks of per-day availability for the day-strip jumper (public endpoint). */
export const getRoundAvailabilityRange = (
  days = 14,
): Promise<ApiResult<{ from: string; days: StaffDayAvailability[] }>> =>
  apiRequest(`/rounds/availability-range?days=${days}`);

/** Booked customers of a round with arrival status — the "מי הגיע" list. */
export const getRoundAttendees = (
  roundInstanceId: string,
): Promise<ApiResult<{ attendees: RoundAttendee[] }>> =>
  apiRequest(`/staff/rounds/${roundInstanceId}/attendees`);
