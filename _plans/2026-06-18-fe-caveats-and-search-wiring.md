# Frontend caveat fixes + customer search/detail wiring

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-18-frontend-api-client.md`

The previous chunk flipped staff login to live but flagged two caveats (no personalized name in the greeting; no auto-refresh on 401) and left customer search on mock. This chunk closes both caveats and turns the read-side of the customer flow live end-to-end.

---

## 1. Goals

- Greeting on POS shows the real logged-in staff member's first name. Pull it from an expanded `/auth/me` response.
- A 30+ minute idle session refreshes its access token transparently instead of kicking the user to a login screen. If refresh fails, the session drops and the login form appears.
- Customer search in POS calls `GET /customers?q=...` (debounced) against the real API, with loading / empty / error states.
- Selecting a search result opens the customer detail screen rendered from `GET /customers/:id` (real customer + cards + entries).
- The punch button on the customer detail screen is visually present but **disabled** with a "ניקוב יחובר בעדכון הבא" note, because wiring the write side of punch is a separate, focused chunk with its own concurrency + idempotency surface.

Success looks like: log in as the seeded admin → search "כהן" → live results stream in after a beat → click a result → see the real customer's name, phone, card pebbles, history, children → log out, wait 16+ minutes → search again → request succeeds transparently (refresh under the hood) with no re-login.

## 2. Locked decisions

### 2.1 Name source: expand `/auth/me`, not the JWT

`/auth/me` adds a DB round-trip and returns `{ user: { id, role, firstName, lastName, email } }`. The JWT stays minimal (sub + role only).

Why over expanding the JWT: JWTs are stored in cookies and sent on every request — bloating them with name/email adds bytes per request forever. A single round-trip on app boot is cheaper and lets future profile changes (renaming a staff member) take effect on the next page refresh without re-issuing tokens. The DB query is `SELECT first_name, last_name, email, role, is_active FROM staff WHERE id = $1 LIMIT 1` — sub-millisecond on a tiny table.

Rejected: putting name in JWT claims. Rejected: a separate `/staff/me` endpoint (extra surface for no benefit; `/auth/me` is already where "who am I" lives).

### 2.2 Auto-refresh: in `api.ts`, deduplicated, with skip-list

`apiRequest` retries once on 401, but only if the path is NOT in the skip-list (`/auth/refresh`, `/auth/login`, `/auth/logout`). `/auth/me` IS in the auto-refresh path because the "user reopens the tab after the access cookie expired" case is exactly what this is for.

Refresh attempts are deduplicated via a module-level promise: parallel 401s share one refresh call. If refresh succeeds, all share the retried success; if it fails, all return 401 and the `onSessionExpired` callback fires (once).

Rejected: per-component refresh handling. Rejected: a separate refresh hook the components call. Both push complexity outward for no win. The api module is the right place.

### 2.3 onSessionExpired callback: module-level singleton registered by the provider

`api.ts` exposes `setOnSessionExpired(fn)`. The `StaffSessionProvider` registers a callback on mount (drops state to `signed-out`) and unregisters on unmount. Singleton is fine — only one provider exists per page.

### 2.4 Customer search: debounced (250ms), abortable, server-paginated by limit=20

Each keystroke after a 250ms quiet window triggers a fetch. In-flight requests are aborted when a newer query arrives (`AbortController`). API returns at most 20 results; the search UI shows a "+המשיכו לסנן" hint if `results.length === 20` (no offset pagination yet, but the hint sets the expectation).

Why debounce + abort instead of a full TanStack-style query manager: one input, one resource, no cache invalidation needs. Native `AbortController` does the heavy lifting in 5 lines.

Empty input ⇒ no fetch, no results shown (matches current UX).

### 2.5 Customer detail: real read, punch button visibly disabled

The detail screen is reshaped to consume `{ customer, cards, entries }` from `/customers/:id`. The "active" card is `cards.find(c => c.isActive) ?? cards[0]`. The punch button stays visible (so the UI doesn't shrink) but is `disabled` with a small "ניקוב יחובר בעדכון הבא" note below it. This is the honest position: the data shown is real; the only action that would change it is acknowledged as not-yet-wired.

Rejected: hiding the punch button. Hiding it removes the affordance the user expects and signals "this screen is broken." Disabling with a note signals "this is coming."

## 3. Files this chunk produces or modifies

```
packages/db/src/accounts.ts                   # add getStaffById (safe view)
packages/db/src/accounts.test.ts              # cover getStaffById
apps/api/src/routes/auth.ts                   # /auth/me: read staff row, return name+role
apps/web/src/lib/api.ts                       # auto-refresh + setOnSessionExpired
apps/web/src/lib/api.test.ts                  # auto-refresh tests
apps/web/src/lib/api/auth.ts                  # expand MeResponse with firstName/lastName/email
apps/web/src/lib/api/customers.ts             # new: search + detail
apps/web/src/lib/api/customers.test.ts        # new: thin coverage of result shape
apps/web/src/lib/staff-session.tsx            # register onSessionExpired
apps/web/src/pos/PosApp.tsx                   # greeting uses session name; Search + Customer reshaped
```

No new external deps.

## 4. Build sequence

1. Backend first: `getStaffById` + `/auth/me` expansion + tests. Run the api suite green.
2. Frontend client: types + auto-refresh + `setOnSessionExpired` + customers client + tests.
3. Frontend wiring: greeting, then search, then customer detail.
4. Typecheck + build + format-check + full test sweep.

## 5. Security (rule 13)

- `getStaffById` returns the public staff view only (id, firstName, lastName, phone, email, role, isActive, createdAt). The password hash is excluded at the SELECT level, matching the existing `staffView` projection in accounts.ts.
- `/auth/me` requires `requireAuthHook` (already in place) AND now also explicitly 404s if the staff row was deleted or deactivated since the token was issued. A deleted-but-still-tokened user is logged out on next /me hit.
- Auto-refresh: only triggers on 401 from non-auth paths. A `/auth/login` 401 returns immediately so the user sees "invalid credentials." A `/auth/refresh` 401 also returns immediately (no infinite refresh loop).
- Customer search: scoped behind `requireRoleHook('cashier','manager','admin')` server-side (already enforced). The client never tries to render results without an active session.
- AbortController prevents leaking earlier-query results into a newer query's UI state (the classic "I typed X then Y, X's response came back later and overwrote Y's").

## 6. Observability (rule 14)

- `[web api] retrying after 401 refresh` on auto-refresh success.
- `[web api] session expired` on auto-refresh failure (also triggers the `onSessionExpired` callback).
- `[web search]` for debounce fire / abort / response — make typing-too-fast vs slow-server diagnosable from the console.
- `[auth me]` server-side: log `{ id, role }` on success; on the deleted-staff path log `[auth me] staff row missing or inactive, signing out`.

## 7. Testing (rule 18)

- `packages/db/src/accounts.test.ts`: add 2 tests — getStaffById returns the safe view + omits the password hash; returns undefined for unknown id.
- `apps/web/src/lib/api.test.ts`: add 3 tests for auto-refresh — 401 followed by 200-after-refresh succeeds; 401 followed by 401-after-refresh fails and calls onSessionExpired; refresh is skipped for /auth/login.
- `apps/web/src/lib/api/customers.test.ts`: thin test that the request URL contains the query param and the response is unwrapped to `results`.
- The api endpoint suite (apps/api) stays at 23 green. The new /auth/me shape doesn't break the existing 401-without-auth assertions.

## 8. Settings (rule 15)

No new user-facing settings. Auto-refresh is an infrastructure concern. Search debounce (250ms) is hardcoded — surfacing it as a user setting would be over-engineering. Future "Settings" surface might expose a "results per page" knob; not now.

## 9. Yanai blockers

None. This chunk runs entirely on the existing infrastructure.

## 10. Out of scope (deferred)

- Punch flow wiring (POST /punch). Visually present + disabled.
- Sell card flow (POST /cards). Mock.
- Scan QR flow (POST /punch via QR). Mock.
- New customer creation (POST /customers). Mock.
- Customer area (OTP) wiring. Separate provider; separate chunk.
- Admin surface wiring (dashboard, dormant report). Separate chunk.
- Optional marketing fields from Yanai's feedback. Awaiting his confirmation.

## 11. Alternatives rejected

- **Stuff name in JWT.** Bloats every request; couples display name to token rotation; rejected.
- **Drop the punch button.** Removes the affordance staff expects to see; rejected in favor of disabled-with-note.
- **TanStack Query for search.** One input, one resource — overkill; rejected.
- **Server-side push for session expiry.** Nice in theory; massive overhead for a single-user POS app. The client-driven retry-then-signal pattern is sufficient.

## 12. Open questions

None blocking.
