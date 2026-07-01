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
  /** A companion checkout was started but not paid — show "complete payment". */
  companionPending: boolean;
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
): Promise<
  ApiResult<{
    date: string;
    /** false = rounds switched off for this date (or globally) — free play, nothing to book. */
    roundsRequired: boolean;
    companionPriceIls: number;
    rounds: AvailabilityRound[];
  }>
> => apiRequest(`/rounds/availability?date=${encodeURIComponent(date)}`, { audience: 'customer' });

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

export interface CompanionCheckoutResult {
  /** WC order-pay URL to redirect to. Absent when free or already paid. */
  payUrl?: string;
  wcOrderId?: number;
  priceIls?: number;
  /** Price setting is 0 — companion confirmed without payment. */
  confirmed?: boolean;
  /** The pending order turned out to be paid — the webhook confirms it. */
  alreadyPaid?: boolean;
}

export const startCompanionCheckout = (
  bookingId: string,
): Promise<ApiResult<CompanionCheckoutResult>> =>
  apiRequest('/rounds/companion/checkout', {
    method: 'POST',
    body: { bookingId },
    audience: 'customer',
  });

export interface CustomerWaitlistEntry {
  entryId: string;
  roundInstanceId: string;
  label: string;
  date: string;
  startTime: string;
  endTime: string;
  status: 'waiting' | 'notified';
  requestedType: 'child_under_walking' | 'child_over_walking';
  /** Set only when notified — when the offer lapses. */
  claimExpiresAt: string | null;
}

export const getMyWaitlist = (): Promise<ApiResult<{ entries: CustomerWaitlistEntry[] }>> =>
  apiRequest('/rounds/waitlist/mine', { audience: 'customer' });

export const joinWaitlist = (
  roundInstanceId: string,
  ticketType: 'child_under_walking' | 'child_over_walking',
): Promise<ApiResult<{ entryId: string; position: number; alreadyOnList: boolean }>> =>
  apiRequest('/rounds/waitlist/join', {
    method: 'POST',
    body: { roundInstanceId, ticketType },
    audience: 'customer',
  });

export const leaveWaitlist = (entryId: string): Promise<ApiResult<{ ok: true }>> =>
  apiRequest('/rounds/waitlist/leave', {
    method: 'POST',
    body: { entryId },
    audience: 'customer',
  });
