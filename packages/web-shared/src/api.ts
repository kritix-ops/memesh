// Typed HTTP client for the Memesh API. Returns a discriminated union — the
// same shape as `@memesh/auth`'s AuthVerifyResult — so callers branch on `ok`
// instead of wrapping every call in try/catch. Network failures (rare, usually
// a programming bug) still throw.
//
// Base URL resolution: `VITE_API_URL` if set, otherwise `/api`. The `/api`
// default works in two topologies without configuration:
//   1. Dev: Vite proxies `/api/*` → http://localhost:3001/*
//   2. Prod single-origin Cloudways: reverse proxy forwards `/api/*` → api
// In a split topology (Vercel + Cloudways), set `VITE_API_URL=https://api.memesh.co.il`.
//
// Auto-refresh: on a 401 from any non-auth path, the client transparently
// POSTs to /auth/refresh and retries the original request once. Parallel 401s
// share a single in-flight refresh promise. If refresh fails, the optional
// `onSessionExpired` callback fires so the session provider can drop to
// signed-out without each component having to detect it.

// Vite replaces `import.meta.env.VITE_API_URL` at compile time. In a Node
// (test) context `import.meta.env` is undefined, so optional chaining keeps
// the module loadable for unit tests.
const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const RAW_BASE = VITE_ENV?.['VITE_API_URL'] ?? '/api';
const BASE_URL = RAW_BASE.replace(/\/$/, '');

// Paths that must never trigger an auto-refresh:
//   - /auth/refresh itself would infinite-loop
//   - /auth/login: a 401 means "wrong credentials" and should surface to the user
//   - /auth/logout: a 401 just means "you were already signed out"; refresh adds nothing
const SKIP_AUTO_REFRESH = new Set(['/auth/refresh', '/auth/login', '/auth/logout']);

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * 'staff' (default): a 401 attempts /auth/refresh and retries once. If refresh
 * also fails, `onSessionExpired` fires.
 * 'customer': no auto-refresh (there is no customer refresh endpoint; a 401
 * means the 7-day cookie expired or was never set). `onCustomerSessionExpired`
 * fires so the customer provider can drop to signed-out.
 */
export type ApiAudience = 'staff' | 'customer';

export interface ApiRequestInit {
  method?: ApiMethod;
  body?: unknown;
  /** Optional AbortSignal so callers can cancel in-flight requests (e.g. debounced search). */
  signal?: AbortSignal;
  /** Which session a 401 belongs to. Defaults to 'staff'. */
  audience?: ApiAudience;
}

// ---------------------------------------------------------------------------
// Refresh + session-expired plumbing
// ---------------------------------------------------------------------------

let refreshInflight: Promise<boolean> | null = null;
let onSessionExpired: (() => void) | null = null;
let onCustomerSessionExpired: (() => void) | null = null;

/**
 * Register a callback invoked once when /auth/refresh fails after a staff 401.
 * The `StaffSessionProvider` sets this on mount so the session state drops to
 * `signed-out` automatically. Set to `null` to unregister.
 */
export function setOnSessionExpired(fn: (() => void) | null): void {
  onSessionExpired = fn;
}

/**
 * Register a callback invoked on a 401 from any audience:'customer' call. The
 * `CustomerSessionProvider` sets this so the customer state drops to
 * `signed-out` automatically. Set to `null` to unregister.
 */
export function setOnCustomerSessionExpired(fn: (() => void) | null): void {
  onCustomerSessionExpired = fn;
}

async function tryRefresh(): Promise<boolean> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      return res.ok;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshInflight;
  } finally {
    refreshInflight = null;
  }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Perform an authenticated request against the Memesh API. Cookies are always
 * included (the session is HttpOnly cookies set by the API on /auth/login).
 */
export async function apiRequest<T>(
  path: string,
  init: ApiRequestInit = {},
  _retried = false,
): Promise<ApiResult<T>> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  const fetchInit: RequestInit = { method, headers, credentials: 'include' };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchInit.body = JSON.stringify(init.body);
  }
  if (init.signal) {
    fetchInit.signal = init.signal;
  }

  const url = `${BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(url, fetchInit);
  } catch (err) {
    // Network failure (DNS, connection refused, TLS, offline, etc.). Caller-
    // initiated aborts re-throw so debounced callers (e.g. searchCustomers)
    // can distinguish "I cancelled this" from "the network is down".
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    console.warn('[web api] network error', { method, path, error: String(err) });
    // Mirror the audience-based 401 routing so the session provider drops to
    // signed-out instead of hanging on `'loading'` forever when the API is
    // unreachable. Without this, an outage of api.memesh.co.il produces an
    // endless spinner on every frontend's first render.
    if (!_retried) {
      if (init.audience === 'customer') {
        onCustomerSessionExpired?.();
      } else if (!SKIP_AUTO_REFRESH.has(path)) {
        onSessionExpired?.();
      }
    }
    return { ok: false, status: 0, error: 'network_error' };
  }

  if (response.ok) {
    // 204 No Content (no body); cast as T and let the caller's narrow type win.
    if (response.status === 204) {
      console.info('[web api]', method, path, response.status);
      return { ok: true, data: undefined as unknown as T };
    }
    try {
      const data = (await response.json()) as T;
      console.info('[web api]', method, path, response.status);
      return { ok: true, data };
    } catch (err) {
      // The server returned a 2xx with a non-JSON body — almost always the
      // SPA's index.html bleeding through a misconfigured proxy. Treat as a
      // transport-layer failure, not a real success.
      console.warn('[web api] invalid response body', { method, path, error: String(err) });
      return { ok: false, status: response.status, error: 'invalid_response' };
    }
  }

  // 401 handling depends on the call's audience:
  //   - 'customer': no auto-refresh (no customer refresh endpoint). Fire the
  //     customer-session-expired callback so the provider drops to signed-out.
  //   - 'staff' (default): at most one auto-refresh + retry, skipping the
  //     staff-auth paths themselves; fire onSessionExpired if refresh fails.
  if (response.status === 401 && !_retried) {
    if (init.audience === 'customer') {
      console.info('[web api] customer 401', { path });
      onCustomerSessionExpired?.();
    } else if (!SKIP_AUTO_REFRESH.has(path)) {
      console.info('[web api] 401, attempting refresh', { path });
      const refreshed = await tryRefresh();
      if (refreshed) {
        console.info('[web api] retrying after 401 refresh', { path });
        return apiRequest<T>(path, init, true);
      }
      console.warn('[web api] session expired', { path });
      onSessionExpired?.();
    }
  }

  // Try to read a structured error body; fall back to a generic `http_NNN`.
  let errorCode: string | undefined;
  try {
    const errorBody = (await response.json()) as { error?: string };
    errorCode = errorBody.error;
  } catch {
    // Non-JSON error response.
  }
  const error = errorCode ?? `http_${response.status}`;
  console.warn('[web api]', method, path, response.status, error);
  return { ok: false, status: response.status, error };
}

/** Exposed for tests and the dev console; do not depend on this in components. */
export const __BASE_URL_FOR_TESTS = BASE_URL;
