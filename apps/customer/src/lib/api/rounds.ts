import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Mirrors the customer-facing rounds endpoints in
// apps/api/src/routes/rounds-booking.ts.

export interface CustomerRoundBooking {
  bookingId: string;
  roundInstanceId: string;
  label: string;
  /** YYYY-MM-DD */
  date: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  status: 'confirmed' | 'used';
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  barcodeToken: string | null;
}

export interface AvailabilityRound {
  roundInstanceId: string;
  label: string;
  startTime: string;
  endTime: string;
  capacity: number;
  available: number;
  isClosed: boolean;
}

export const getMyRoundBookings = (): Promise<ApiResult<{ bookings: CustomerRoundBooking[] }>> =>
  apiRequest('/rounds/my-bookings', { audience: 'customer' });

export const getRoundAvailability = (
  date: string,
): Promise<ApiResult<{ date: string; rounds: AvailabilityRound[] }>> =>
  apiRequest(`/rounds/availability?date=${encodeURIComponent(date)}`, { audience: 'customer' });

export const swapRoundBooking = (
  bookingId: string,
  targetRoundInstanceId: string,
): Promise<ApiResult<{ bookingId: string; barcodeToken: string }>> =>
  apiRequest('/rounds/swap', {
    method: 'POST',
    body: { bookingId, targetRoundInstanceId },
    audience: 'customer',
  });
