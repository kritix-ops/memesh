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
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
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

export const cancelRoundBooking = (
  bookingId: string,
): Promise<ApiResult<{ ok: true; refunded: boolean; punchReturned: boolean; refundAmountIls: number }>> =>
  apiRequest('/rounds/cancel', {
    method: 'POST',
    body: { bookingId },
    audience: 'customer',
  });

export const bookRoundWithPunch = (
  punchCardId: string,
  roundInstanceId: string,
  ticketType: 'child_under_walking' | 'child_over_walking',
): Promise<ApiResult<{ bookingId: string; barcodeToken: string; remaining: number }>> =>
  apiRequest('/rounds/book-punch', {
    method: 'POST',
    body: { punchCardId, roundInstanceId, ticketType },
    audience: 'customer',
  });
