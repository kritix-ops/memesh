import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Participant actions on a round instance, mirroring apps/api/src/routes/
// staff-rounds.ts. Attendees + move + walk-in are staff-gated (admin passes);
// remove is admin-only (it can move money). The admin live dashboard drives all
// of these from an expandable round tile.

export interface RoundAttendee {
  bookingId: string;
  bookingNumber: string | null;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  /** `manual` = a staff walk-in add, shown apart from the registered ones. */
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  arrived: boolean;
  usedAt: string | null;
}

export const listRoundAttendees = (
  roundInstanceId: string,
): Promise<ApiResult<{ attendees: RoundAttendee[] }>> =>
  apiRequest(`/staff/rounds/${roundInstanceId}/attendees`);

export interface RemoveBookingResponse {
  ok: true;
  /** A paid booking was refunded via WooCommerce. */
  refunded: boolean;
  /** A punch-card entry was returned to the customer's card. */
  punchReturned: boolean;
  refundAmountIls: number;
}

/** Remove a booking from its round (admin only). Refunds paid / returns punch. */
export const removeBooking = (
  bookingId: string,
): Promise<ApiResult<RemoveBookingResponse>> =>
  apiRequest(`/staff/rounds/bookings/${bookingId}/cancel`, { method: 'POST' });

/** Move a booking to another round instance (the early/late-arrival case). */
export const moveBooking = (
  bookingId: string,
  targetRoundInstanceId: string,
): Promise<ApiResult<{ bookingId: string; barcodeToken: string }>> =>
  apiRequest(`/staff/rounds/bookings/${bookingId}/move`, {
    method: 'POST',
    body: { targetRoundInstanceId },
  });

export interface WalkInResponse {
  bookingId: string;
  bookingNumber: string;
  /** True when the add pushed the round past capacity. */
  overCapacity: boolean;
  taken: number;
  capacity: number;
}

/** Add a walk-in to a round, over capacity when the venue allows it. */
export const addWalkIn = (
  roundInstanceId: string,
  input: { customerId: string; ticketType?: 'child_under_walking' | 'child_over_walking' },
): Promise<ApiResult<WalkInResponse>> =>
  apiRequest(`/staff/rounds/${roundInstanceId}/walk-in`, { method: 'POST', body: input });

export interface ArrivalResponse {
  arrived: boolean;
  usedAt: string | null;
  /** False when the booking was already in the requested state (idempotent). */
  changed: boolean;
}

/** Mark a booking arrived (or undo). Server allows venue-today rounds only. */
export const setTicketArrival = (
  bookingId: string,
  arrived: boolean,
): Promise<ApiResult<ArrivalResponse>> =>
  apiRequest(`/staff/rounds/bookings/${bookingId}/arrival`, { method: 'POST', body: { arrived } });

export interface MoveTargetRound {
  roundInstanceId: string;
  label: string;
  startTime: string;
  endTime: string;
  taken: number;
  capacity: number;
  isClosed: boolean;
}

/**
 * The rounds running on a given date — move targets for a booking on that
 * date. Uses the staff floor read (`?date=` reads any day) so already-started
 * rounds stay listed, unlike the public picker.
 */
export const listRoundsForDate = (
  date: string,
): Promise<ApiResult<{ date: string; rounds: MoveTargetRound[] }>> =>
  apiRequest(`/staff/rounds/today?date=${encodeURIComponent(date)}`);
