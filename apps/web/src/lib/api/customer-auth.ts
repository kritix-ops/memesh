import { apiRequest, type ApiResult } from '../api';

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
