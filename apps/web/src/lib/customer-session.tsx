import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { setOnCustomerSessionExpired } from './api';
import {
  customerLogout,
  requestEmailOtp as requestEmailOtpApi,
  requestOtp as requestOtpApi,
  verifyEmailOtp as verifyEmailOtpApi,
  verifyOtp as verifyOtpApi,
} from './api/customer-auth';
import { getMe, type CustomerProfile } from './api/me';

/**
 * Customer session state. Mirrors StaffSessionProvider's shape, with two-step
 * OTP login (request + verify) instead of password. The HttpOnly customer
 * cookie is the source of truth — this provider hydrates from /me on mount
 * and registers an onCustomerSessionExpired callback so a later 401 drops
 * state to signed-out.
 */

export type CustomerSessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; profile: CustomerProfile }
  | { status: 'signed-out' };

export type SignInResult = { ok: true } | { ok: false; error: string };
export type RequestOtpResult = { ok: true } | { ok: false; error: string };

interface CustomerSessionContextValue {
  state: CustomerSessionState;
  requestOtp: (phone: string) => Promise<RequestOtpResult>;
  verifyOtp: (phone: string, code: string) => Promise<SignInResult>;
  /** Email-OTP fallback when SMS fails or the customer changed phone numbers. */
  requestEmailOtp: (email: string) => Promise<RequestOtpResult>;
  verifyEmailOtp: (email: string, code: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  /** Refresh the cached profile after a successful PATCH /me, etc. */
  refresh: () => Promise<void>;
  /** Replace the cached profile when a mutation returned the new shape. */
  setProfile: (profile: CustomerProfile) => void;
}

const CustomerSessionContext = createContext<CustomerSessionContextValue | undefined>(undefined);

export function CustomerSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CustomerSessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setOnCustomerSessionExpired(() => {
      if (cancelled) return;
      console.info('[web customer me] session expired callback, dropping to signed-out');
      setState({ status: 'signed-out' });
    });
    (async () => {
      console.info('[web customer me] hydrating');
      const res = await getMe();
      if (cancelled) return;
      if (res.ok) {
        console.info('[web customer me] hydrated signed in', {
          customerNumber: res.data.profile.customerNumber,
        });
        setState({ status: 'signed-in', profile: res.data.profile });
      } else {
        console.info('[web customer me] hydrated signed out');
        setState({ status: 'signed-out' });
      }
    })();
    return () => {
      cancelled = true;
      setOnCustomerSessionExpired(null);
    };
  }, []);

  const requestOtp = useCallback(async (phone: string): Promise<RequestOtpResult> => {
    console.info('[web customer auth] request otp', { phone: maskPhone(phone) });
    const res = await requestOtpApi(phone);
    if (!res.ok) {
      console.warn('[web customer auth] request otp failed', { error: res.error });
      return { ok: false, error: res.error };
    }
    return { ok: true };
  }, []);

  const verifyOtp = useCallback(async (phone: string, code: string): Promise<SignInResult> => {
    console.info('[web customer auth] verify', { phone: maskPhone(phone) });
    const verifyRes = await verifyOtpApi(phone, code);
    if (!verifyRes.ok) {
      console.warn('[web customer auth] verify failed', { error: verifyRes.error });
      return { ok: false, error: verifyRes.error };
    }
    // Cookie is now set. Pull /me to learn the profile.
    const meRes = await getMe();
    if (!meRes.ok) {
      console.warn('[web customer auth] me after verify failed');
      return { ok: false, error: 'session_unavailable' };
    }
    console.info('[web customer auth] signed in', {
      customerNumber: meRes.data.profile.customerNumber,
    });
    setState({ status: 'signed-in', profile: meRes.data.profile });
    return { ok: true };
  }, []);

  const requestEmailOtp = useCallback(async (email: string): Promise<RequestOtpResult> => {
    console.info('[web customer auth] request email otp', { email: maskEmail(email) });
    const res = await requestEmailOtpApi(email);
    if (!res.ok) {
      console.warn('[web customer auth] request email otp failed', { error: res.error });
      return { ok: false, error: res.error };
    }
    return { ok: true };
  }, []);

  const verifyEmailOtp = useCallback(
    async (email: string, code: string): Promise<SignInResult> => {
      console.info('[web customer auth] verify email', { email: maskEmail(email) });
      const verifyRes = await verifyEmailOtpApi(email, code);
      if (!verifyRes.ok) {
        console.warn('[web customer auth] verify email failed', { error: verifyRes.error });
        return { ok: false, error: verifyRes.error };
      }
      const meRes = await getMe();
      if (!meRes.ok) {
        console.warn('[web customer auth] me after email verify failed');
        return { ok: false, error: 'session_unavailable' };
      }
      console.info('[web customer auth] signed in via email', {
        customerNumber: meRes.data.profile.customerNumber,
      });
      setState({ status: 'signed-in', profile: meRes.data.profile });
      return { ok: true };
    },
    [],
  );

  const signOut = useCallback(async () => {
    console.info('[web customer auth] logout');
    try {
      await customerLogout();
    } catch (err) {
      console.warn('[web customer auth] logout request threw', err);
    }
    setState({ status: 'signed-out' });
  }, []);

  const refresh = useCallback(async () => {
    const res = await getMe();
    if (res.ok) setState({ status: 'signed-in', profile: res.data.profile });
    else setState({ status: 'signed-out' });
  }, []);

  const setProfile = useCallback((profile: CustomerProfile) => {
    setState({ status: 'signed-in', profile });
  }, []);

  return (
    <CustomerSessionContext.Provider
      value={{
        state,
        requestOtp,
        verifyOtp,
        requestEmailOtp,
        verifyEmailOtp,
        signOut,
        refresh,
        setProfile,
      }}
    >
      {children}
    </CustomerSessionContext.Provider>
  );
}

export function useCustomerSession(): CustomerSessionContextValue {
  const ctx = useContext(CustomerSessionContext);
  if (!ctx) throw new Error('useCustomerSession must be used within a CustomerSessionProvider');
  return ctx;
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}***`;
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}
