import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Mirrors GET /rounds/my-bookings in apps/api/src/routes/rounds-booking.ts.
// The customer's active/upcoming round bookings + barcodes.

export interface CustomerRoundBooking {
  bookingId: string;
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

export const getMyRoundBookings = (): Promise<ApiResult<{ bookings: CustomerRoundBooking[] }>> =>
  apiRequest('/rounds/my-bookings', { audience: 'customer' });
