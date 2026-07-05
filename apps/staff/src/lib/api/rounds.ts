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
  /** Human-friendly ticket number — lets the floor cross-check a spoken number. */
  bookingNumber: string | null;
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

/** Per-day availability for the day-strip jumper and the month calendar
 *  (public endpoint). `from` defaults to venue today server-side; `maxDate`
 *  is the last date of the booking window — the calendar stops there. */
export const getRoundAvailabilityRange = (
  days = 14,
  from?: string,
): Promise<ApiResult<{ from: string; maxDate: string; days: StaffDayAvailability[] }>> =>
  apiRequest(
    `/rounds/availability-range?days=${days}${from ? `&from=${encodeURIComponent(from)}` : ''}`,
  );

/** Booked customers of a round with arrival status — the "מי הגיע" list. */
export const getRoundAttendees = (
  roundInstanceId: string,
): Promise<ApiResult<{ attendees: RoundAttendee[] }>> =>
  apiRequest(`/staff/rounds/${roundInstanceId}/attendees`);

/** Mark a booked customer in (or undo a mistaken tap). Venue-today only. */
export const setBookingArrival = (
  bookingId: string,
  arrived: boolean,
): Promise<ApiResult<{ arrived: boolean; usedAt: string | null; changed: boolean }>> =>
  apiRequest(`/staff/rounds/bookings/${bookingId}/arrival`, {
    method: 'POST',
    body: { arrived },
  });

export interface CustomerDayBooking {
  bookingId: string;
  bookingNumber: string | null;
  roundInstanceId: string;
  label: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  arrived: boolean;
  usedAt: string | null;
}

/** A customer's bookings for the venue-local today — the POS mark-them-in path. */
export const getCustomerRoundsToday = (
  customerId: string,
): Promise<ApiResult<{ date: string; bookings: CustomerDayBooking[] }>> =>
  apiRequest(`/staff/customers/${customerId}/rounds-today`);

export interface CheckinBooking {
  bookingId: string;
  bookingNumber: string | null;
  customer: { firstName: string; lastName: string; phone: string };
  label: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  /** YYYY-MM-DD */
  date: string;
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  status: 'held' | 'confirmed' | 'used' | 'cancelled' | 'expired';
  arrived: boolean;
  usedAt: string | null;
}

/** Resolve a ticket for door check-in — scanned QR token or typed R- number. */
export const lookupCheckin = (input: {
  token?: string;
  bookingNumber?: string;
}): Promise<ApiResult<{ booking: CheckinBooking }>> =>
  apiRequest('/staff/rounds/checkin/lookup', { method: 'POST', body: input });
