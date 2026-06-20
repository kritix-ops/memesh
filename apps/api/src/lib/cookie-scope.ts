import { env } from '../config.js';

/**
 * Cookie attributes shared by every session cookie the API issues. When
 * COOKIE_DOMAIN is set (split-subdomain topology, e.g. ".memesh.co.il"),
 * the Domain attribute is added so the cookie survives the cross-subdomain
 * hop from frontend (staff./admin./my.) to api. Otherwise the cookie stays
 * origin-scoped, which is what apps/web today expects.
 *
 * SameSite=lax is correct in both shapes: *.memesh.co.il are same-site under
 * one eTLD+1, so credentialed fetches survive the subdomain hop, while
 * cross-site POSTs are still blocked (the CSRF surface we care about).
 */
export interface CookieScope {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  domain?: string;
}

/** Pure helper: build a CookieScope from explicit inputs. Trivial to unit-test. */
export const cookieScopeFor = (opts: { isProd: boolean; domain?: string }): CookieScope => {
  const base: CookieScope = {
    httpOnly: true,
    secure: opts.isProd,
    sameSite: 'lax',
    path: '/',
  };
  if (opts.domain && opts.domain.length > 0) {
    return { ...base, domain: opts.domain };
  }
  return base;
};

export const cookieScope = (): CookieScope => {
  const isProd = env.NODE_ENV === 'production';
  // `exactOptionalPropertyTypes` rejects an explicit `undefined` on optional
  // keys, so include `domain` only when it's actually set.
  return env.COOKIE_DOMAIN
    ? cookieScopeFor({ isProd, domain: env.COOKIE_DOMAIN })
    : cookieScopeFor({ isProd });
};

/**
 * Attributes used when clearing a cookie. Must match the path AND domain the
 * cookie was set with; otherwise the browser keeps the cookie alive. Mirrors
 * cookieScope() but omits httpOnly/secure/sameSite/maxAge which clearCookie
 * sets itself.
 */
export interface ClearCookieScope {
  path: '/';
  domain?: string;
}

/** Pure helper: build a ClearCookieScope from explicit inputs. */
export const clearCookieScopeFor = (opts: { domain?: string }): ClearCookieScope => {
  if (opts.domain && opts.domain.length > 0) {
    return { path: '/', domain: opts.domain };
  }
  return { path: '/' };
};

export const clearCookieScope = (): ClearCookieScope =>
  env.COOKIE_DOMAIN
    ? clearCookieScopeFor({ domain: env.COOKIE_DOMAIN })
    : clearCookieScopeFor({});
