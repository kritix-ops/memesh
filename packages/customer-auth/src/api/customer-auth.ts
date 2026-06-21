import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Customer (phone + OTP) auth surface. The verify-otp call sets an HttpOnly
// customer_token cookie that subsequent /me / /me/cards calls send back
// automatically. All paths flag audience:'customer' so a 401 fires the
// customer-session-expired callback instead of trying the staff refresh.

export interface RequestOtpResponse {
  ok: true;
}

export interface VerifyOtpResponse {
  ok: true;
  /** Same value as the cookie; the web app does not read it (cookie is HttpOnly). */
  token: string;
}

/**
 * Ask the server to send an OTP to the given phone. Always succeeds (the
 * server intentionally does not reveal whether the phone is registered).
 */
export const requestOtp = (phone: string): Promise<ApiResult<RequestOtpResponse>> =>
  apiRequest('/auth/customer/request-otp', {
    method: 'POST',
    body: { phone },
    audience: 'customer',
  });

/** Verify the OTP and start a customer session (sets the HttpOnly cookie). */
export const verifyOtp = (phone: string, code: string): Promise<ApiResult<VerifyOtpResponse>> =>
  apiRequest('/auth/customer/verify-otp', {
    method: 'POST',
    body: { phone, code },
    audience: 'customer',
  });

/** End the customer session server-side (clears the cookie). Idempotent. */
export const customerLogout = (): Promise<ApiResult<{ ok: true }>> =>
  apiRequest('/auth/customer/logout', {
    method: 'POST',
    audience: 'customer',
  });

// ---------------------------------------------------------------------------
// Email-OTP fallback (Yanay 2026-06-20). Used when SMS fails or the customer
// has changed their phone number. The server only sends when the email
// matches an existing customers.email exactly; the route never reveals
// whether the address is on file.
// ---------------------------------------------------------------------------

/**
 * Ask the server to send a login code via email. Always returns ok:true
 * regardless of whether the email is on file (opaque shape mirrors the SMS
 * path so the endpoint never leaks customer existence).
 */
export const requestEmailOtp = (email: string): Promise<ApiResult<RequestOtpResponse>> =>
  apiRequest('/auth/customer/request-email-otp', {
    method: 'POST',
    body: { email },
    audience: 'customer',
  });

/** Verify the email code and start a customer session (same cookie as SMS). */
export const verifyEmailOtp = (
  email: string,
  code: string,
): Promise<ApiResult<VerifyOtpResponse>> =>
  apiRequest('/auth/customer/verify-email-otp', {
    method: 'POST',
    body: { email, code },
    audience: 'customer',
  });

// ---------------------------------------------------------------------------
// WooCommerce checkout handoff. WordPress redirects the buyer to
// my.memesh.co.il/checkout-complete?token=<raw> after a successful checkout;
// the page calls this verify endpoint to exchange the token for the same
// HttpOnly customer_token cookie the OTP flow sets, then forwards them to /.
// ---------------------------------------------------------------------------

import type { CustomerProfile } from './me';

export interface HandoffVerifyResponse {
  ok: true;
  profile: CustomerProfile;
}

/**
 * Exchange a single-use handoff token (minted by the WP plugin) for a
 * customer session cookie. 401 on any failure (replay, expired, garbage,
 * unknown) — the page falls back to OTP login in that case.
 */
export const verifyHandoffToken = (
  token: string,
): Promise<ApiResult<HandoffVerifyResponse>> =>
  apiRequest('/auth/customer/wc-handoff/verify', {
    method: 'POST',
    body: { token },
    audience: 'customer',
  });
