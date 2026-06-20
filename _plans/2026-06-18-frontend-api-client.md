# Frontend API Client + Staff Login

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md` (handoff section, NEXT step 2)
Predecessor: `_plans/2026-06-18-api-deployment-kit.md`

This plan covers the second half of the handoff's NEXT step: a typed API client in `apps/web` plus the first surface flipped from mock to live — the Staff/POS login. After this chunk, a cashier can actually log in against the real API end-to-end (POS landing page, header greeting, log out) while customer search, ticket sale, and punch flow remain on mock data until the next iteration.

---

## 1. Goals

- Stand up a single, typed, framework-free `api` module in `apps/web` that every surface uses for every HTTP call. No fetch calls scattered across components.
- Make session state a first-class app concern: a `StaffSessionProvider` that hydrates from `/auth/me` on mount, exposes `signIn` / `signOut`, and gates the POS + Admin surfaces behind login.
- Flip exactly one surface to live: the staff login flow. Cashier enters phone + password, gets a cookie session from the real API, lands on the POS home with their real name in the greeting.
- Keep everything else on mock data so the diff stays reviewable.

Success looks like: `pnpm --filter @memesh/web dev` + `pnpm --filter @memesh/api dev` running side by side, a developer enters the seeded admin's phone+password, the SPA calls the real API, sets a real cookie, fetches `/auth/me`, and renders the POS home greeting with the real name. Refreshing the page keeps them logged in. "התנתק" logs them out.

## 2. Locked decisions

### 2.1 Base URL: VITE_API_URL with `/api` default + Vite dev proxy

The client's base URL is `import.meta.env.VITE_API_URL ?? '/api'`. In dev the Vite proxy maps `/api/*` → `http://localhost:3001/*` (strips the prefix). In prod the same `/api/*` path is handled by the reverse proxy (Cloudways → API container). Same SPA code in both environments — one env var, one default.

Why: any frontend deployment topology that funnels the API through a `/api/*` prefix works without changing client code. The single-origin Cloudways recommendation from the deployment plan is the default; a split topology (Vercel + Cloudways) becomes a one-line env override.

### 2.2 Cookie paths: `/` for both access_token and refresh_token

The current API sets the refresh cookie at `path: '/auth/refresh'`. With any `/api/*` proxy, the browser stores the cookie at the path the server sent and the actual refresh request goes to `/api/auth/refresh` — paths mismatch, cookie not sent, refresh broken. Fix: set both cookies at `path: '/'`.

The security tradeoff is essentially zero: cookies are HttpOnly + sameSite=lax + Secure (in prod), so the path-scoping never gated a real attack — it only gated convenience. The ~100-byte refresh-cookie overhead on non-auth requests is negligible.

Files touched: `apps/api/src/routes/auth.ts` (two lines in `setAuthCookies`, plus the `clearCookie` calls in `/auth/logout`).

### 2.3 Session state: React context + `/auth/me` hydration

A `StaffSessionProvider` at the top of `App.tsx` mounts a hook that calls `/auth/me` once. Three states: `loading`, `signed-in`, `signed-out`. Provider exposes `signIn(phone, password)`, `signOut()`, and the current `user` object.

- No localStorage / sessionStorage. The cookie IS the session; reading it back from `/auth/me` is the source of truth. Survives refresh because the cookie does.
- 401 from `/auth/me` ⇒ `signed-out`. 401 from any other call ⇒ also `signed-out` (no silent auto-refresh in this chunk; the explicit gate is simpler to reason about).

Rejected: third-party state library (Zustand, Jotai, TanStack Query). Overkill for one resource and adds review surface. Plain React context matches the existing `useViewport` hook style.

Rejected: auto-refresh-on-401 in this chunk. The refresh endpoint exists and works (tested); wiring auto-refresh is a clean follow-up once the basic flow is shipped. Adding it now triples the state machine.

### 2.4 Error shape: discriminated union, not throws

The client's HTTP wrapper returns `{ ok: true; data: T } | { ok: false; status: number; error: string }`. Callers branch on `ok`. No throws for HTTP errors. Network failures DO throw (rare, programming bug).

Why: discriminated unions match the existing `qr-engine` and `auth` patterns in this codebase (`isAuthSuccess` etc.). Components can render error states without try/catch noise.

### 2.5 One file per route family

`apps/web/src/lib/api.ts` is the typed fetch wrapper + base URL resolution + error shape. Per-route modules live alongside (e.g., `lib/api/auth.ts`, `lib/api/customers.ts`) but only `lib/api/auth.ts` lands in this chunk. Empty-but-ready scaffolding for the others would just be churn.

## 3. Files this chunk produces or modifies

```
apps/web/src/lib/api.ts                   # typed fetch wrapper + base URL
apps/web/src/lib/api/auth.ts              # login, me, logout typed methods
apps/web/src/lib/staff-session.tsx        # React context + provider + useStaffSession hook
apps/web/src/lib/api.test.ts              # client unit tests (no fetch mocks; uses Node 22 native test fetch stub via globalThis)
apps/web/src/pos/StaffLoginForm.tsx       # new component, RTL Hebrew
apps/web/vite.config.ts                   # add /api proxy (dev only)
apps/web/.env.example                     # VITE_API_URL=/api documented
apps/web/src/App.tsx                      # wrap with StaffSessionProvider + gate POS/admin
apps/web/src/pos/PosApp.tsx               # consume useStaffSession; greeting + logout button
apps/api/src/routes/auth.ts               # cookie paths -> '/'
apps/api/src/app.test.ts                  # update any cookie-path assertions (none currently)
```

No changes to: backend logic, schema, deployment kit. The cookie-path change is the only API-side delta and it's narrowly scoped.

## 4. Build sequence

1. **API cookie-path fix first.** Two lines + run the api test suite. Confirms the change is harmless and lets the rest of the chunk be purely frontend.
2. **API client module** (`apps/web/src/lib/api.ts`) + auth methods (`lib/api/auth.ts`). Include a small test against `globalThis.fetch` stubbed with a fake.
3. **Staff session** (`lib/staff-session.tsx`). Provider hydrates on mount via the client; exposes `signIn`, `signOut`, and the user state.
4. **Login form** (`pos/StaffLoginForm.tsx`). Phone + password fields, validation, calls `signIn`, shows server error on 401.
5. **Wire `App.tsx`** to render the login gate when not signed in on the staff/admin surface, and pass through to PosApp / AdminApp when signed in. Customer surface untouched (different auth model).
6. **Wire `PosApp.tsx`** home greeting to show the real user, and add a discreet log-out affordance in the existing header.
7. **Vite proxy + `.env.example`**: drop in the proxy config + document the env var.
8. **Verify**: `pnpm --filter @memesh/web typecheck` + `build`, then run the test for `api.ts`, then end-to-end manually with both dev servers running.

## 5. Security (rule 13)

- The client always uses `credentials: 'include'` so HttpOnly cookies travel with requests. It never reads or writes auth cookies directly (it can't — they're HttpOnly).
- Login form: `inputMode='tel'` for phone, `type='password'` for the password. Browser autofill behaves correctly. No `console.log` of credentials, ever.
- Session state never includes the password. Only the public user fields (id, role) that `/auth/me` returns.
- 401 on a hydration call ⇒ silently sign out, show login. Don't surface "session expired" toasts that leak whether a request was authenticated — the login form re-prompt is the affordance.
- Logout calls `/auth/logout` first, THEN clears local React state. If the network call fails, we still clear local state (defense-in-depth: the user's intent is to log out).
- The Vite dev proxy is a dev-only convenience and does not ship in the production bundle.

## 6. Observability (rule 14)

- The API client logs `[web api]` + method + path + status on every response, at `console.info` for success and `console.warn` for 4xx/5xx. Tagged so a cashier reporting "it just doesn't work" gives logs that match what we see server-side.
- The staff session logs `[web auth] hydrating`, `[web auth] signed in`, `[web auth] signed out`, with no PII other than role.
- Login form logs `[web auth] login attempt` (no password ever, of course) + the server response status.
- API server already logs the auth flow as `[auth login]` / `[auth refresh]`; the matching `[web auth]` prefix makes cross-side diagnosis a grep across two log streams.

## 7. Testing (rule 18)

- `apps/web/src/lib/api.test.ts`: covers (a) base URL resolution (default vs env override), (b) success shape, (c) 4xx error shape, (d) 5xx error shape, (e) `credentials: 'include'` is always set. Uses `globalThis.fetch` stub — no MSW, no node-fetch mocks; native `Response` constructor.
- The login form, session provider, and PosApp changes are smoke-tested manually in the dev servers — full React-Testing-Library coverage on a small UI is more setup than it's worth for one form. If the form's logic grows (validation rules, multi-step flow), a future chunk gets the test bed.
- The API cookie-path change is verified by re-running the existing `apps/api` test suite (all 23 tests must stay green).

## 8. Settings (rule 15)

This chunk introduces no user-facing controls. Logout is not a setting — it's an action. The future "Settings" surface will, when built, expose:

- Cashier display name override (vanity field) — out of scope here.
- Theme / contrast / text size — out of scope here.
- Session timeout override — backend-only env for now (`ACCESS_MAX_AGE_SEC`); future settings work surfaces it for admins.

## 9. Yanai blockers

None for this chunk. Everything is internal: typed client, session, login form, gating. Yanai's pending items (Cloudways access, WP credentials, WC scope) all land later. We continue without them.

## 10. Out of scope (deferred)

- **Customer search wiring to `/customers`.** Stays on mock. Next chunk.
- **POS punch flow** wiring to `/punch`. Stays on mock. Next chunk after search.
- **Customer area** OTP login + `/me/cards`. Different auth audience; separate chunk.
- **Admin dashboard** wiring to `/admin/dashboard`. Last in the surface flip order.
- **Auto-refresh on 401.** Wires the existing refresh endpoint into the client. Small, contained follow-up after this lands.
- **Form validation polish + "מומלץ" badge** from Yanai's feedback item 1. Lives with the customer-creation wiring (next chunk).
- **Optional marketing fields** from Yanai's feedback item 2. Blocked on his approval of the field list.

## 11. Alternatives rejected

- **TanStack Query / SWR for fetching.** Earns its keep with caching + invalidation. We don't have a complex cache surface yet — the session is one resource. Adding it now is premature complexity. Reconsider if/when the customer search needs debounced live results.
- **Mounting Fastify under `/api` prefix.** Discussed; would change all routes server-side. Larger blast radius than fixing two cookie paths. Rejected in favor of the cookie-path change.
- **Reading cookies in JS to track session.** Cookies are HttpOnly; JS can't read them. Even if they weren't, doing so would defeat the security model. The hydration call to `/auth/me` is the right check.
- **A login modal over the existing surface switcher.** A modal hides the surface switcher, which is the only navigation. Better: replace the surface body with a centered login card while keeping the header. The user always knows they're "on" the staff surface, just locked out.

## 12. Open questions

None blocking. The customer surface's auth integration (phone + OTP) is its own design; it will reuse the same `lib/api.ts` wrapper but get a separate `CustomerSessionProvider` with a different token audience.
