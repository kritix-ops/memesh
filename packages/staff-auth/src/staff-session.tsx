import { setOnSessionExpired } from '@memesh/web-shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { staffLogin, staffLogout, staffMe, type StaffUser } from './api/auth';

/**
 * Staff session state. The cookie set by the API is the source of truth; this
 * provider hydrates from /auth/me on mount, exposes signIn / signOut, and
 * gates the staff + admin surfaces. Customer-area auth (phone + OTP) uses a
 * separate provider with a different token audience.
 */

export type StaffSessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; user: StaffUser }
  | { status: 'signed-out' };

export type SignInResult = { ok: true } | { ok: false; error: string };

interface StaffSessionContextValue {
  state: StaffSessionState;
  signIn: (phone: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
}

const StaffSessionContext = createContext<StaffSessionContextValue | undefined>(undefined);

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StaffSessionState>({ status: 'loading' });

  // Hydrate from /auth/me on mount. Any 401 (or missing user) lands us in
  // signed-out; the login form takes over from there. Also register the
  // session-expired callback so a later 401-then-refresh-failure drops state
  // here without each component having to detect it.
  useEffect(() => {
    let cancelled = false;
    setOnSessionExpired(() => {
      if (cancelled) return;
      console.info('[web auth] session expired callback, dropping to signed-out');
      setState({ status: 'signed-out' });
    });
    (async () => {
      console.info('[web auth] hydrating');
      const res = await staffMe();
      if (cancelled) return;
      if (res.ok && res.data.user) {
        console.info('[web auth] hydrated signed in', { role: res.data.user.role });
        setState({ status: 'signed-in', user: res.data.user });
      } else {
        console.info('[web auth] hydrated signed out');
        setState({ status: 'signed-out' });
      }
    })();
    return () => {
      cancelled = true;
      setOnSessionExpired(null);
    };
  }, []);

  const signIn = useCallback(async (phone: string, password: string): Promise<SignInResult> => {
    console.info('[web auth] login attempt', { phone });
    const loginRes = await staffLogin(phone, password);
    if (!loginRes.ok) {
      console.warn('[web auth] login failed', {
        status: loginRes.status,
        error: loginRes.error,
      });
      return { ok: false, error: loginRes.error };
    }
    // Login succeeded and the cookie is set. Pull /auth/me to learn the staff
    // identity (the login response gives role but not the canonical user shape).
    const meRes = await staffMe();
    if (!meRes.ok || !meRes.data.user) {
      console.warn('[web auth] me after login failed');
      return { ok: false, error: 'session_unavailable' };
    }
    console.info('[web auth] signed in', { role: meRes.data.user.role });
    setState({ status: 'signed-in', user: meRes.data.user });
    return { ok: true };
  }, []);

  const signOut = useCallback(async () => {
    console.info('[web auth] signing out');
    // Clear server-side first, then local state. Even if the network call
    // fails (offline, server down), we still drop the local session — the
    // user's intent is to log out.
    try {
      await staffLogout();
    } catch (err) {
      console.warn('[web auth] logout request threw', err);
    }
    setState({ status: 'signed-out' });
    console.info('[web auth] signed out');
  }, []);

  return (
    <StaffSessionContext.Provider value={{ state, signIn, signOut }}>
      {children}
    </StaffSessionContext.Provider>
  );
}

export function useStaffSession(): StaffSessionContextValue {
  const ctx = useContext(StaffSessionContext);
  if (!ctx) throw new Error('useStaffSession must be used within a StaffSessionProvider');
  return ctx;
}
