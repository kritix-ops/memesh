import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Gift card claim API surface. Three endpoints, all unauthenticated — the
// claim token (URL path) is the auth gate, with phone-OTP on top to block
// email-forwarding attacks.
//
// Mirrors the server contract in apps/api/src/routes/gift-claim.ts.

export interface GiftPreviewCard {
  totalEntries: number;
  /** Days the card stays valid after claim. null = forever. */
  validityDays: number | null;
}

export interface GiftPreview {
  buyerFirstName: string;
  recipientFirstName: string;
  card: GiftPreviewCard | null;
  /** ISO timestamp the claim link expires. */
  expiresAt: string;
}

export interface GiftPreviewResponse {
  ok: true;
  gift: GiftPreview;
}

/**
 * Fetch the gift summary so the claim page can render the buyer's name +
 * card details before the recipient enters their phone. Does NOT consume
 * the token. 404 = unknown token; 410 = already claimed or expired.
 */
export const getGiftPreview = (
  claimToken: string,
): Promise<ApiResult<GiftPreviewResponse>> =>
  apiRequest(
    `/auth/customer/gift/preview/${encodeURIComponent(claimToken)}`,
    { method: 'GET', audience: 'customer' },
  );

export interface GiftRequestOtpResponse {
  ok: true;
}

/**
 * Send an OTP to the recipient's phone. Server validates the phone matches
 * what the buyer entered at WC checkout — phone mismatch returns 403
 * `phone_mismatch`, which is the email-forwarding-attack defense.
 */
export const requestGiftClaimOtp = (
  claimToken: string,
  phone: string,
): Promise<ApiResult<GiftRequestOtpResponse>> =>
  apiRequest('/auth/customer/gift/request-otp', {
    method: 'POST',
    body: { claimToken, phone },
    audience: 'customer',
  });

export interface GiftClaimResponse {
  ok: true;
  /** Same value as the HttpOnly customer cookie just set. */
  token: string;
  customerId: string;
}

/**
 * Verify the OTP and materialize the gift. On success the server sets the
 * HttpOnly customer_token cookie so the next page load lands the recipient
 * in their personal area with the new card visible.
 */
export const claimGift = (
  claimToken: string,
  phone: string,
  code: string,
): Promise<ApiResult<GiftClaimResponse>> =>
  apiRequest('/auth/customer/gift/claim', {
    method: 'POST',
    body: { claimToken, phone, code },
    audience: 'customer',
  });
