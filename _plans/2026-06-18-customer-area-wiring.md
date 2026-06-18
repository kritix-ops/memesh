# Customer area wiring (OTP login + my cards + profile)

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md` (handoff section, surface flips)
Predecessor: `_plans/2026-06-18-sell-and-new-customer-wiring.md`

Flips the `אזור אישי` (customer area) tab from mock to live: phone + OTP login, real "my cards" view, real profile edit, logout. Closes the second of the three Phase 1 surfaces.

---

## 1. Goals

- Customer enters phone → SMS OTP arrives (or, today, lands in the API console via the stub provider) → enters 6-digit code → signed in.
- Once signed in, sees their real cards (pebbles + serial + expiry + QR placeholder) and history-style info from the live API.
- Profile screen edits the live row via `PATCH /me`. Phone stays locked (it's the login identity).
- Logout calls a new `POST /auth/customer/logout` which clears the HttpOnly cookie server-side.
- Session persists across tab switches and page refreshes (cookie + provider hydration).

Success looks like: open `אזור אישי` → enter a phone that a registered customer owns → wait one beat (OTP stub logs the code to the API stdout) → enter that code → see your real cards. Tap "עריכת פרטים", change your email, save, refresh — the change persists.

## 2. Locked decisions

### 2.1 Audience-aware API client

The current `api.ts` auto-refresh-on-401 assumes a staff session and hits `/auth/refresh`. That's wrong for customer routes (no customer refresh endpoint; a 401 on `/me` means session-expired, full stop). Add an optional `audience: 'staff' | 'customer'` to `ApiRequestInit`:

- Staff (default): existing behavior — auto-refresh on 401, fires `onSessionExpired` if refresh fails.
- Customer: NO auto-refresh. On 401, fire a new `onCustomerSessionExpired` callback so the customer provider can drop to signed-out.

Why per-call audience instead of path-prefix inspection: the audience is a property of the call, not the URL shape. Future endpoints might mix; flag-based is explicit and survives refactors.

### 2.2 Separate provider, separate state, shared client

`CustomerSessionProvider` mirrors `StaffSessionProvider` but with its own state (`profile` instead of staff `user`) and its own callback registration. Both providers wrap `App.tsx` so sessions survive surface-tab switches. The two cookies (`access_token`, `customer_token`) coexist on the same origin without conflict.

### 2.3 Server-side customer logout (new endpoint)

Without a server-side logout, the cookie stays valid for 7 days. If a customer signs out on a shared device (or hands their phone to a friend), the session would survive. Add `POST /auth/customer/logout` that clears the cookie — same shape as the existing staff logout.

### 2.4 OTP delivery: stub provider logs to API stdout in dev

The brief defers real SMS to a follow-up (019 SMS hookup). For now the stub `ConsoleSmsProvider` prints `[sms] to=... body=...` to the API console. Dev workflow: cashier-style: open the API terminal, watch for the OTP, type it in.

In prod, the same code path swaps the stub for the real provider via env config. No frontend change needed.

### 2.5 Profile edit: name + email + preferredChannel + children

`PATCH /me` accepts these four fields. Phone stays locked client-side (`disabled` input). The form fires one optimistic save → on success, the provider refetches `/me` so the rendered profile and the source of truth converge. On failure, a top-level error.

Children editing is **read-only in this chunk** (we show the chips, but the inline editor is a separate concern). Yanai's marketing fields (item 2) stay deferred until he approves the list.

### 2.6 No "remember device" / "trust this browser"

Brief-locked: OTP is the only customer auth. We do not yet remember a device beyond the 7-day cookie. A future chunk can add longer-lived trusted-device tokens; not now.

## 3. Files this chunk produces or modifies

```
apps/api/src/routes/customer-auth.ts            # add POST /auth/customer/logout
apps/web/src/lib/api.ts                         # audience-aware + onCustomerSessionExpired
apps/web/src/lib/api.test.ts                    # tests for customer audience
apps/web/src/lib/api/customer-auth.ts           # new: requestOtp, verifyOtp, customerLogout
apps/web/src/lib/api/customer-auth.test.ts      # new
apps/web/src/lib/api/me.ts                      # new: getMe, updateMe, getMyCards
apps/web/src/lib/api/me.test.ts                 # new
apps/web/src/lib/customer-session.tsx           # new: provider + hook
apps/web/src/customer/CustomerLogin.tsx         # new: phone + code flow
apps/web/src/customer/CustomerApp.tsx           # rewrite: real session + real data
apps/web/src/App.tsx                            # wrap with CustomerSessionProvider
apps/web/package.json                           # register new test files
```

## 4. Build sequence

1. Backend logout endpoint + a tiny smoke test ensuring it 200s.
2. `api.ts` audience flag + onCustomerSessionExpired + tests.
3. Customer API clients (customer-auth + me) + tests.
4. CustomerSessionProvider.
5. CustomerLogin component (extracted from CustomerApp).
6. CustomerApp rewrite consuming session + me + my-cards.
7. App.tsx wraps with the new provider.
8. Verify: typecheck, tests, build, format. Manual e2e against the local stack.

## 5. Security (rule 13)

- The customer-auth endpoints are rate-limited server-side (5/min for request-otp, 10/min for verify-otp). The client respects this and shows "נסו שוב בעוד רגע" on 429.
- OTP request always responds the same regardless of whether the phone is registered — does not reveal which phones exist. The client therefore shows the "code sent" step even on unregistered phones (only the verify step fails, never the request).
- Customer session cookie is HttpOnly + sameSite=lax + Secure (in prod), same as staff. JS cannot read it; the server is the only source of truth.
- Logout clears the cookie server-side; the client also drops React state immediately. If the network call fails, we still drop local state (user's intent).
- Profile edits: server validates all input with Zod. Children entries are length-capped (20 max).
- Email shown only to its owner via `/me` (the `profileView` projection omits staff-only fields like `internalNotes` and `registeredBy`).

## 6. Observability (rule 14)

- `[web customer auth] request otp` with masked phone.
- `[web customer auth] verify success / failed { error }`.
- `[web customer auth] logout`.
- `[web customer me] hydrated signed in / signed out`.
- `[web customer me] update success / failed`.
- Server-side `[otp request] not sent` already exists; the stub provider's `[sms]` line is the cue to grab the code in dev.

## 7. Testing (rule 18)

- `api.test.ts`: add 2 tests — customer audience does NOT auto-refresh on 401; customer audience fires onCustomerSessionExpired on 401.
- `customer-auth.test.ts` (new): requestOtp body shape; verifyOtp body + 401 invalid_code error code.
- `me.test.ts` (new): getMe unwraps `profile`; updateMe sends PATCH; getMyCards unwraps `cards`.
- Existing 93 tests stay green; expect ~100 total after.

## 8. Settings (rule 15)

- The profile-edit screen IS a kind of settings surface for the customer (preferred channel, email, name). It already lives in the brief's locked design.
- No new operator-facing settings.
- OTP cooldown / resend interval is not exposed; the rate limit is the floor. If we later want a "resend in Ns" timer, it adds a small countdown but the rate limit is the actual gate.

## 9. Yanai blockers

None for this chunk. The OTP stub provider lets the whole flow be tested without a live SMS account.

## 10. Out of scope (deferred)

- Real SMS (019 provider). Today the OTP lands in the API console.
- Children inline editor (read-only chips for now).
- Marketing optional fields (Yanai item 2 — awaiting his approval).
- Long-lived "trust this device" token.
- Resend-cooldown countdown UX (rate limit covers safety; UX nice-to-have).
- Cards beyond `is_active=true` (the API filters; expired cards are not shown to the customer — design choice in the brief).

## 11. Alternatives rejected

- **Path-prefix-based audience detection.** Brittle; rejected in favor of explicit per-call flag.
- **Single SessionProvider with role discrimination.** Couples staff and customer states unnecessarily; either bug expands the blast radius. Two providers, two state machines.
- **Client-only logout (no backend endpoint).** Leaves the cookie valid for 7 days. Rejected; added the endpoint.
- **Resend-OTP button at the same rate limit.** Already implicit via the request-otp call. Adding a dedicated button is one button + same call; cleanest is to just expose the existing API.

## 12. Open questions

None blocking.
