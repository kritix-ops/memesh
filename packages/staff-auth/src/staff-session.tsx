import { setOnSessionExpired } from '@memesh/web-shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { staffLogin, staffLogout, staffMe, type StaffUser } from './api/auth';

/**
 * Staff session state. The cookie set by the API is the source of truth; this
 * provider hydrates from /auth/me on mount, exposes signIn / signOut, and
 * gates the staff + admin surfaces. Customer-area auth (phone + OTP) uses a
 * separate provider with a different token audience.
 *
 * The signed-out branch also exposes a sub-view selector (login | forgot |
 * reset) so the login form can switch in place between sign-in, request-reset,
 * and finish-reset without each consuming app needing a router. The `reset`
 * view auto-activates when the URL carries `?reset_token=...`.
 */

export type StaffSessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; user: StaffUser }
  | { status: 'signed-out' };

export type SignInResult = { ok: true } | { ok: false; error: string };

export type SignedOutView = 'login' | 'forgot' | 'reset';

interface StaffSessionContextValue {
  state: StaffSessionState;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  signedOutView: SignedOutView;
  setSignedOutView: (view: SignedOutView) => void;
  /** Raw reset token detected in the URL when signedOutView is 'reset'. */
  resetToken: string | null;
  /**
   * Called by the reset flow after a successful password reset. Strips
   * `?reset_token=...` from the URL so a page refresh does not re-enter the
   * reset view, and returns the user to the login screen.
   */
  clearResetToken: () => void;
}

const StaffSessionContext = createContext<StaffSessionContextValue | undefined>(undefined);

/**
 * Read the reset token from the URL (if any), without consuming it. We don't
 * strip the param here because the token has to survive the React mount — the
 * reset form needs to POST it. `clearResetToken` strips it after success.
 */
function readResetTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('reset_token');
    return token && token.length >= 16 ? token : null;
  } catch {
    return null;
  }
}

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StaffSessionState>({ status: 'loading' });
  const [resetToken, setResetToken] = useState<string | null>(() => readResetTokenFromUrl());
  const [signedOutView, setSignedOutView] = useState<SignedOutView>(() =>
    readResetTokenFromUrl() ? 'reset' : 'login',
  );

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
      console.info('[web auth] hydrating', { hasResetToken: !!resetToken });
      const res = await staffMe();
      if (cancelled) return;
      if (res.ok && res.data.user) {
        // If the URL has a reset token, prefer the reset flow over an already
        // signed-in session: someone clicking a reset link probably wants to
        // act on it, not bypass it because a stale cookie happens to be valid.
        if (resetToken) {
          console.info('[web auth] hydrated signed in but reset token present, signing out');
          await staffLogout().catch(() => undefined);
          setState({ status: 'signed-out' });
          setSignedOutView('reset');
          return;
        }
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
    // resetToken is read once on mount; setting it later is a no-op for hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    console.info('[web auth] login attempt', { email });
    const loginRes = await staffLogin(email, password);
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
    setSignedOutView('login');
    console.info('[web auth] signed out');
  }, []);

  const clearResetToken = useCallback(() => {
    console.info('[web auth] clearing reset token from URL');
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('reset_token');
      window.history.replaceState({}, '', url.toString());
    }
    setResetToken(null);
    setSignedOutView('login');
  }, []);

  return (
    <StaffSessionContext.Provider
      value={{
        state,
        signIn,
        signOut,
        signedOutView,
        setSignedOutView,
        resetToken,
        clearResetToken,
      }}
    >
      {children}
    </StaffSessionContext.Provider>
  );
}

export function useStaffSession(): StaffSessionContextValue {
  const ctx = useContext(StaffSessionContext);
  if (!ctx) throw new Error('useStaffSession must be used within a StaffSessionProvider');
  return ctx;
}
