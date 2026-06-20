---
title: Split Memesh into three subdomains (staff, admin, my) with a dedicated API
date: 2026-06-20
status: proposed
owner: Yoav
supersedes: _plans/2026-06-19-split-admin-customer-subdomains.md
---

# Split Memesh into three subdomains with a dedicated API

## Goal in one sentence

Replace today's single Vite app at `memesh.co.il` with three independently deployed frontends — `staff.memesh.co.il` (POS), `admin.memesh.co.il` (admin), `my.memesh.co.il` (customer personal area) — backed by one shared Fastify API at `api.memesh.co.il`, with all four subdomains hidden from search engines and DNS managed in Cloudflare in DNS-only mode.

## What changed vs. the 2026-06-19 plan

The earlier plan split into **two** frontends (`admin.` = staff+admin together, `my.` = customer) and deferred the standalone API origin to a later phase. The new shape is **three** frontends plus a standalone API. Three things flow from that:

1. **Staff and admin become physically separate apps.** They still share the same JWT, but now live on different origins, so the auth cookie has to span subdomains. That means `domain=.memesh.co.il` on staff cookies from day one (deferred in the old plan).
2. **The API gets its own origin.** Three frontends would otherwise need three byte-identical copies of the bundled Fastify app on Vercel — that's not just wasteful, it's a real drift hazard. With three surfaces, the cost of a single canonical API (CORS + cookie domain) is worth paying immediately rather than deferring.
3. **All four subdomains must be unindexable.** Apex `memesh.co.il` stays as-is and is the only thing that may eventually be indexable.

## Goals

1. `staff.memesh.co.il` — POS surface for cashiers and floor staff, one Vercel project, its own deploy lifecycle, `noindex`.
2. `admin.memesh.co.il` — admin/management surface (reports, settings, customers), one Vercel project, its own deploy lifecycle, `noindex`.
3. `my.memesh.co.il` — customer personal area only (OTP login, punch cards, activities), one Vercel project, its own deploy lifecycle, `noindex`.
4. `api.memesh.co.il` — single canonical Fastify deploy, one Vercel project, owns the cron jobs, `noindex`.
5. `memesh.co.il` (apex) — untouched in this plan; whatever serves it today keeps serving it.
6. Cloudflare DNS-only (gray cloud) for all four subdomains. Vercel terminates TLS and serves all responses directly.
7. Same database, same `@memesh/api` source. Code is shared via `packages/*`, never copied.
8. A bad deploy to any one frontend cannot break the other two, and cannot break the API.
9. SSO between staff and admin: an admin user signs in once and can navigate between `staff.` and `admin.` without a second login.

## Constraints

- Node 24, pnpm 10, Vite 6, React 19, Fastify on Vercel Functions (Fluid Compute).
- Same data model, same migrations. No schema changes for this work.
- Hebrew-first, RTL-first. No copy changes in flight (other than `noindex` directives that are not user-visible).
- Vercel team `team_dpfv79FB24k9MGaoi3DELiOe`. Today's prod project is `prj_sdAYDj5KEpM0H31dTDod5JAh0A9H` — it gets repurposed for one of the new frontends (probably staff) rather than created from scratch, to preserve deploy history.
- DNS managed in Cloudflare (per user). All new records added as DNS-only.
- Brother is product owner. No hard deadline. Every shipped step keeps the system fully working.

## Requirements (who/what/when)

- **Cashier** on a cafe terminal lands at `staff.memesh.co.il` — staff login form → POS. No admin tab. No customer surface visible.
- **Admin (brother)** lands at `admin.memesh.co.il` — same staff login form (same credentials) → admin dashboard. Already-signed-in staff cookie from `staff.memesh.co.il` lets him in without re-authenticating, because the cookie is scoped to `.memesh.co.il`. A staff-role-only user who navigates to `admin.memesh.co.il` is signed in but sees an "אין הרשאה" message and a link back to `staff.`.
- **Customer** lands at `my.memesh.co.il` — OTP login → personal area. Never sees staff or admin.
- **External integrations** (today none; in scope: AccuPOS reconciliation cron, future webhooks) hit `api.memesh.co.il` directly.
- **Search engines** see nothing crawlable on any subdomain.

## Out of scope (deliberately)

- Apex landing page work.
- Any refactor of `AdminApp.tsx` (2568 lines) or `PosApp.tsx` (1634 lines). They move whole, untouched.
- Any schema migration. AccuPOS integration changes (per locked decisions memory).
- New auth flows. Same staff JWT + customer phone-OTP scheme. Only cookie *scope* changes.
- The marketing site at apex. The "אזור אישי" link from apex is a future task for whoever owns the marketing site.
- The mock-data swap on the POS welcome stats (already done in this session as a one-line `38`→`0`, `5`→`0` change in [apps/web/src/pos/PosApp.tsx:882-883](apps/web/src/pos/PosApp.tsx#L882-L883)). Wiring those stats to real backend data is a separate plan.

---

## Chosen approach

**Four Vercel projects in one monorepo: three Vite frontends + one dedicated API. Shared UI in `packages/brand`, shared API client in `packages/web-shared`, shared staff auth surface in `packages/staff-auth`.**

### File layout after the split

```
apps/
  api/                          # unchanged Fastify source (already exists)
    src/                        #   app.ts, server.ts, routes/, plugins/, etc.
    package.json

  api-deploy/                   # NEW — Vercel project for api.memesh.co.il
    api/server.ts               #   thin wrapper that imports the bundled Fastify app
    scripts/build-api-bundle.mjs  # moved from apps/web/scripts
    vercel.json                 #   owns the cron jobs (wc-reconcile)
    package.json
    .env.example

  staff/                        # NEW — Vercel project for staff.memesh.co.il
    src/
      App.tsx                   #   thin shell: brand header, RTL, no tab switcher, no admin link
      main.tsx
      pos/                      #   moved from apps/web/src/pos
    index.html                  #   includes <meta name="robots" content="noindex,nofollow">
    public/robots.txt           #   User-agent: * / Disallow: /
    vercel.json                 #   sets X-Robots-Tag header; rewrites SPA fallback only (no /api/* rewrite — calls go to api.memesh.co.il directly)
    package.json
    vite.config.ts
    .env.example                #   VITE_API_URL=https://api.memesh.co.il

  admin/                        # NEW — Vercel project for admin.memesh.co.il
    src/
      App.tsx                   #   thin shell with admin nav
      main.tsx
      admin/                    #   moved from apps/web/src/admin
    index.html, public/robots.txt, vercel.json, package.json, vite.config.ts, .env.example

  customer/                     # NEW — Vercel project for my.memesh.co.il
    src/
      App.tsx                   #   thin shell, no admin/staff anywhere
      main.tsx
      customer/                 #   moved from apps/web/src/customer
    index.html, public/robots.txt, vercel.json, package.json, vite.config.ts, .env.example

  web/                          # DELETED at the end of phase 5 (was the monolithic app)

packages/
  brand/                        # NEW — Logo, Sun, FauxQr, PunchCard, color tokens
  web-shared/                   # NEW — api fetch wrapper (from apps/web/src/lib/api.ts), fmtDate, shared types
  staff-auth/                   # NEW — StaffSessionProvider, StaffLoginForm, useStaffSession
  customer-auth/                # NEW — CustomerSessionProvider, customer-auth API client, OTP UI
  auth/                         # unchanged
  db/                           # unchanged
  email/                        # unchanged
  qr-engine/                    # unchanged
  sms/                          # unchanged
```

`packages/staff-auth` is consumed by both `apps/staff` and `apps/admin`. `packages/customer-auth` is consumed only by `apps/customer`. `packages/web-shared` and `packages/brand` are consumed by all three frontends.

### Backend topology

**One Fastify deploy at `api.memesh.co.il`. All three frontends call it via `VITE_API_URL=https://api.memesh.co.il` with `credentials: 'include'`.**

Concrete implications:
- **Cookies.** Staff cookies (`access_token`, `refresh_token`) get `domain=.memesh.co.il`, `path=/`, `sameSite=lax`, `secure` in prod, `httpOnly`. Customer cookie (`customer_token`) gets the same scope so it survives the API origin hop on credentialed fetches from `my.memesh.co.il`. `sameSite=lax` is still safe here because `*.memesh.co.il` are same-site under the public-suffix-list-derived eTLD+1, so cookies survive subdomain hops on credentialed same-site requests. Verify against current MDN before phase 4 (rule 1).
- **CORS.** Prod: explicit allowlist of `['https://staff.memesh.co.il', 'https://admin.memesh.co.il', 'https://my.memesh.co.il']` with `credentials: true`. Dev: keep `origin: true` for `localhost`. Never `origin: '*'` — wildcard is incompatible with `credentials: true` per fetch spec.
- **Cron.** The `wc-reconcile` cron (currently in `apps/web/vercel.json`) moves to `apps/api-deploy/vercel.json`. Only the API project owns crons.

### Cookie session-bridge story for SSO across staff/admin

Because the staff cookie is scoped to `.memesh.co.il`, an admin user who signs in on `staff.memesh.co.il` and then visits `admin.memesh.co.il` is already authenticated — `StaffSessionProvider` in `admin` hydrates from the same `/auth/me` call and finds the same cookie. No redirect dance, no SSO server. The admin app shows an "no permission" screen with a link back to `staff.` for users with `role=staff` (not `role=admin`).

### Search engine exclusion

Belt and braces for all four `*.memesh.co.il` subdomains:

1. **HTTP header on every response.** Each frontend's `vercel.json` adds `X-Robots-Tag: noindex, nofollow` to all routes. The API project does the same — Fastify can add the header via an `onSend` hook so even error responses carry it. (Header is the only mechanism that works for non-HTML responses.)
2. **HTML meta tag.** Each frontend's `index.html` has `<meta name="robots" content="noindex, nofollow">` in `<head>`. Belt for crawlers that follow meta but ignore headers.
3. **`/robots.txt`.** Each frontend serves a `public/robots.txt` with `User-agent: *` / `Disallow: /`. Braces for the well-behaved crawlers.

(`robots.txt` alone is insufficient — it tells crawlers not to fetch, but a URL discovered via inbound link can still be indexed without being fetched. The `X-Robots-Tag` header is what actually prevents indexing.)

### DNS plan (Cloudflare, DNS-only)

Four new records, all proxied OFF (gray cloud):

| Subdomain                  | Type  | Target                          | Proxy  |
|----------------------------|-------|---------------------------------|--------|
| `staff.memesh.co.il`       | CNAME | `cname.vercel-dns.com`          | DNS-only |
| `admin.memesh.co.il`       | CNAME | `cname.vercel-dns.com`          | DNS-only |
| `my.memesh.co.il`          | CNAME | `cname.vercel-dns.com`          | DNS-only |
| `api.memesh.co.il`         | CNAME | `cname.vercel-dns.com`          | DNS-only |

Vercel will issue TLS certs via Let's Encrypt for each. Verify cert issuance succeeds on each subdomain *before* promoting traffic.

## Alternatives considered and rejected

### Alt 1: Stay with the 2-subdomain plan (staff+admin together, customer separate)

Keep `admin.memesh.co.il` as the combined staff+admin surface, `my.memesh.co.il` as customer.

- **Pro:** half the infrastructure. Two Vercel projects, no need for `domain=.memesh.co.il` cookies, simpler CORS, fewer drift surfaces. Matches the seam that already exists in code (staff and admin share `StaffSessionProvider` today).
- **Con:** staff and admin remain coupled at the deploy lane. An admin-only release still ships the POS bundle. The header tab between staff/admin remains a visible-to-cashier control even though it's gated on role.
- **Rejected because:** user explicitly chose the 3-subdomain shape. The cost is real but bounded, and the operational separation (staff terminal can't be navigated to admin even by URL accident) has value for a multi-cashier setup.

### Alt 2: 3 frontends, each ships its own copy of the API (Option A from the old plan, extended)

Each Vite project includes a `/api/server` Vercel function that bundles `apps/api`. No `api.memesh.co.il`.

- **Pro:** no CORS, no cookie-domain widening. Same-origin everywhere.
- **Con:** three API copies on Vercel. Drift hazard cubed vs. one copy. Cron has to pick a home and stay there. Every API change needs three deploys to fully roll out.
- **Rejected because:** the drift risk was already a flagged concern in the 2-subdomain plan. With 3 frontends it's worse. One canonical API is the right shape; the CORS + cookie-domain cost is a one-time setup, not ongoing.

### Alt 3: Two Vercel projects, route by hostname

Keep one Vite app and one Vercel project. Pick the surface (`staff` / `admin` / `customer`) from `window.location.hostname` at boot.

- **Pro:** smallest diff.
- **Con:** one bundle, one deploy, one failure mode. Customer downloads admin code unless we lazy-split. Doesn't actually deliver the "three independent surfaces" goal.
- **Rejected because:** it's the illusion of separation, not the operational thing. Already rejected in the 2-subdomain plan; rejected harder here.

### Alt 4: Cloudflare proxy ON for all subdomains

Put CF in front, layer CF firewall rules and CF-edge caching.

- **Pro:** WAF, geo-block, DDoS shaping, page rules.
- **Con:** more moving parts during the cut. CF caching of any HTML/dynamic response can mask Vercel deploy issues. Cert handshake needs Full (Strict). `X-Robots-Tag` header set at Vercel still reaches the browser, but if you ever set conflicting CF transform rules it gets confusing fast.
- **Rejected because:** user chose DNS-only. We can flip subdomains to proxied later if a specific threat (DDoS, bot scraping) shows up.

## Phased execution

Each phase ends with every URL we care about returning a 200. No phase leaves the system half-broken.

### Phase 0 — Pre-flight (no code yet)

- [ ] Confirm Vercel team has headroom for **3 more projects** (`memesh-staff`, `memesh-admin`, `memesh-customer`, plus the new `memesh-api`). The existing `memesh` project is repurposed for one of these (probably staff) to preserve deploy history; net new is three.
- [ ] Snapshot DB (Neon point-in-time mark) before any deploys.
- [ ] In Cloudflare, confirm we can add CNAMEs for `staff.`, `admin.`, `my.`, `api.` and that we won't hit any existing record collisions.
- [ ] Confirm cookies-domain decision with brother in plain language: "after the change, signing in on `staff.memesh.co.il` keeps you signed in on `admin.memesh.co.il`. OK?"

### Phase 1 — Lift shared code into `packages/*`

This is the largest mechanical-but-safe phase. Done while everything still lives in `apps/web`. No user-visible change.

- [ ] Create `packages/brand` — move `Logo`, `Sun`, `FauxQr`, `PunchCard`, the shared color/spacing tokens currently inline in `brand.tsx` / `App.tsx`. Export typed React components.
- [ ] Create `packages/web-shared` — move the API fetch wrapper from [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts), `fmtDate`, and any other formatting utility consumed by more than one surface. Export `setOnSessionExpired`, the typed `apiFetch`, etc.
- [ ] Create `packages/staff-auth` — move `StaffSessionProvider`, `useStaffSession`, `StaffLoginForm`, and the `api/auth.ts` client into here. Depends on `@memesh/web-shared`.
- [ ] Create `packages/customer-auth` — move `CustomerSessionProvider`, `api/customer-auth.ts`, `api/me.ts`, and the OTP UI into here. Depends on `@memesh/web-shared`.
- [ ] Update `apps/web` to import from the four new packages instead of `./lib` / `./brand`. Build, `tsc --noEmit`, run existing tests. No behavior change.
- [ ] Commit. Single PR. Reviewable diff.

### Phase 2 — Carve out `apps/api-deploy` (canonical API)

- [ ] Create `apps/api-deploy/` with `api/server.ts`, `scripts/build-api-bundle.mjs` (copied verbatim from `apps/web/scripts/`), `vercel.json` (with the `wc-reconcile` cron and the `X-Robots-Tag: noindex, nofollow` header), `package.json`, `.env.example` (DATABASE_URL, JWT_*, SMS creds, SERVER_SECRET_KEY).
- [ ] Add the CORS allowlist to `apps/api/src/plugins/cors.ts` (or wherever CORS is configured): prod = the three frontend origins, dev = `localhost`.
- [ ] Add the `X-Robots-Tag: noindex, nofollow` `onSend` hook in Fastify.
- [ ] Modify staff and customer cookie setters to include `domain=.memesh.co.il` when running in prod. Keep dev cookies origin-scoped (no `domain` attribute), to avoid breaking localhost dev.
- [ ] Local sanity: run `apps/api-deploy` locally, confirm it still serves everything `apps/web` expects.
- [ ] Commit. `apps/web` still works (it still has its own bundled API copy until phase 5).

### Phase 3 — Carve out `apps/staff`

- [ ] Create `apps/staff/` with `package.json` (`@memesh/staff`), `vite.config.ts`, `tsconfig.json`, `index.html` (with the noindex meta), `public/robots.txt`, `vercel.json` (SPA fallback rewrite, X-Robots-Tag header, **no /api rewrite** — frontend calls `https://api.memesh.co.il` directly via `VITE_API_URL`).
- [ ] Move `apps/web/src/pos/` → `apps/staff/src/pos/`.
- [ ] Write `apps/staff/src/App.tsx`: brand header, RTL, mounts `StaffSessionProvider` + `PosApp`. No tab switcher. No admin nav. Signed-out shows `StaffLoginForm`.
- [ ] Add `apps/staff/.env.example` with `VITE_API_URL=https://api.memesh.co.il`.
- [ ] Local sanity: `pnpm --filter @memesh/staff dev` against `apps/api-deploy` running locally. Staff login → POS → punch a card. Cookies present and accepted across the cross-origin call.
- [ ] Commit. `apps/web` still untouched.

### Phase 4 — Carve out `apps/admin`

- [ ] Create `apps/admin/` with the same skeleton as `apps/staff/`.
- [ ] Move `apps/web/src/admin/` → `apps/admin/src/admin/`.
- [ ] Write `apps/admin/src/App.tsx`: brand header, RTL, mounts `StaffSessionProvider` + `AdminApp`. Signed-out → `StaffLoginForm`. Signed in with `role=staff` (not admin) → "אין הרשאה" screen with a link to `staff.memesh.co.il`.
- [ ] Local sanity: same as staff. Confirm SSO: sign in on `staff.localhost`, hit `admin.localhost`, no second login required. (Use the Vite dev-server with a `/etc/hosts` entry mapping both names to 127.0.0.1.)
- [ ] Commit.

### Phase 5 — Carve out `apps/customer`, delete `apps/web`

- [ ] Create `apps/customer/` skeleton.
- [ ] Move `apps/web/src/customer/` → `apps/customer/src/customer/`.
- [ ] Write `apps/customer/src/App.tsx`: brand header, RTL, mounts `CustomerSessionProvider` + `CustomerApp`. No staff/admin code reachable from any path.
- [ ] Add minimal unit tests on each of the three frontends asserting the *other* surfaces are not transitively imported (catch the highest-cost mistake: accidental re-import).
- [ ] Delete `apps/web/` entirely. Run `pnpm -r build`, `pnpm -r test`, `pnpm -r typecheck`. All green.
- [ ] Commit.

### Phase 6 — Wire four Vercel projects

- [ ] In the Vercel dashboard:
  - Rename existing `memesh` project to `memesh-staff`. Set its root directory to `apps/staff`. Add domain `staff.memesh.co.il`.
  - Create `memesh-admin`. Root directory `apps/admin`. Add domain `admin.memesh.co.il`.
  - Create `memesh-customer`. Root directory `apps/customer`. Add domain `my.memesh.co.il`.
  - Create `memesh-api`. Root directory `apps/api-deploy`. Add domain `api.memesh.co.il`.
- [ ] Set env vars per project. All four share `JWT_*` and `SERVER_SECRET_KEY`. The API project owns `DATABASE_URL` and SMS creds. The three frontends only need `VITE_API_URL=https://api.memesh.co.il`. Document the must-be-identical secrets in `.env.example` with a sharp warning.
- [ ] Add the four Cloudflare CNAMEs (DNS-only).
- [ ] Verify Vercel TLS issuance on each subdomain. Hit each via curl, confirm `X-Robots-Tag: noindex, nofollow` is in the response headers.
- [ ] Smoke-test using Vercel preview URLs first, then promote to the custom domains.

### Phase 7 — Verify and harden

- [ ] Full manual QA pass (see Testing).
- [ ] Verify `site:staff.memesh.co.il`, `site:admin.memesh.co.il`, `site:my.memesh.co.il`, `site:api.memesh.co.il` return zero results in Google after a week. If anything shows up, file a removal request via Google Search Console and re-verify the headers.
- [ ] Update `memesh-brief-v3.md` to reflect the new topology.

---

## Security (rule 13)

The cookie-scope change is the biggest single security delta in this plan. Walking the surface:

- **Staff cookies broadened to `.memesh.co.il`.** Today they're scoped to one origin. After the cut they ride to all four subdomains, including the customer subdomain. That's fine cryptographically — the customer API routes don't accept `access_token` — but it does mean a staff-or-admin user who is also a customer carries staff cookies on every customer-subdomain fetch. Harmless functionally; small information leak (the customer subdomain knows you're also staff). Acceptable for an internal tool used by a handful of people. Document explicitly.
- **Customer cookie scope.** Same widening — `domain=.memesh.co.il`. Customer cookie is `customer_token`, distinct from staff cookies, so staff routes don't accept it. Same low-risk profile.
- **CORS allowlist.** Prod must be an explicit allowlist of exactly the three frontend origins with `credentials: true`. **Never** `origin: '*'` — fetch spec disallows wildcard origin with credentialed requests anyway, but worth saying out loud.
- **`sameSite=lax`.** Stays as today. Lax blocks cross-site POSTs (the CSRF surface). `*.memesh.co.il` are same-site under the public-suffix-list-derived eTLD+1, so cookies survive the cross-origin-but-same-site fetch from frontend to API. Verify against current MDN before phase 6 cutover (rule 1 — cookie semantics shift faster than they should).
- **HSTS.** Vercel sets HSTS by default per subdomain. We additionally want `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on the apex if/when we control it — out of scope here but call out.
- **Secret duplication.** Four Vercel projects share `JWT_SECRET`. Drift = silent customer logouts and unverifiable staff JWTs. The .env.example files must call this out with bold warning text, and a future improvement is to put these in a Vercel-team-level shared env (Vercel supports this).
- **Cross-surface session leakage QA.** Try to hit `/admin/users` with only a customer cookie via cross-origin fetch from `my.memesh.co.il`. Confirm 401. Try the reverse (staff cookie on `/me/cards`). Confirm 401.
- **Phishing surface.** Four subdomains = four typo-squat targets. Mitigation: nothing today; document as future work to register lookalikes if traffic warrants.
- **Search-engine indexing.** Noindex is a *privacy* control here, not just SEO. The customer subdomain in particular shouldn't be discoverable. Triple-layered (header + meta + robots.txt) so a single misconfig doesn't blow it open.

## Observability (rule 14)

Each new surface gets the existing namespaced-log pattern from day one. No retrofitting.

- **Build pipeline.** Each project's build script prefixes `[build staff]`, `[build admin]`, `[build customer]`, `[build api]` so a failed Vercel build is immediately attributable.
- **Boot.** Each frontend's `main.tsx` logs `[staff boot]` / `[admin boot]` / `[customer boot]` on mount with `{ env, apiBase, version }`. Lets you tell which bundle is actually running in a given tab.
- **Session.** Existing `[web auth]` logs in `staff-session.tsx` get renamed `[staff session]` / `[admin session]` per consuming app so it's clear which frontend emitted them.
- **API.** Add a `[api boot]` log on Fastify startup with `{ commit, env, allowlist }`. Add `[api cors reject]` with the rejected origin on every CORS failure — without it, CORS bugs eat a day.
- **Cookie debug.** Add `[api auth cookie set]` and `[api auth cookie clear]` logs that print the cookie name and computed scope (`domain`, `path`, `sameSite`, `secure`). This is the single highest-value diagnostic for the cookie-domain change.

## Settings (rule 15)

This split is infrastructure. No new user-visible settings introduced. The one knob we are hardcoding for now and might want to expose later: the "staff-only user lands on admin" message could be customized per role. Defer until someone asks.

## Testing (rule 18)

Tests run after every phase, not just at the end. Bar: green relevant suite + manual run through the golden path on the actual domain (or Vercel preview URL pre-cutover).

### Unit tests

- `packages/web-shared/src/api.test.ts` — re-run the existing api-client tests against the moved code. Pure logic; should pass unchanged. If they don't, the move was wrong.
- `packages/staff-auth/src/staff-session.test.tsx` — moved from `apps/web/src/lib/`. Pass unchanged.
- `packages/customer-auth/src/customer-session.test.tsx` — moved from `apps/web/src/lib/`. Pass unchanged.
- `apps/staff/src/App.test.tsx` (new, minimal) — mount the shell, assert it does NOT transitively import `AdminApp` or `CustomerApp`. Use a module-mock check, not just an absence-of-render check.
- `apps/admin/src/App.test.tsx` (new, minimal) — same in reverse: no `PosApp`, no `CustomerApp`.
- `apps/customer/src/App.test.tsx` (new, minimal) — no `PosApp`, no `AdminApp`. Catches the single highest-cost mistake we can make in this split.

### Integration tests (new)

- `apps/api/test/cors.test.ts` — hit a protected endpoint with each of the three allowed origins, confirm `Access-Control-Allow-Origin` mirrors. Hit with `https://evil.example`, confirm reject.
- `apps/api/test/cookie-domain.test.ts` — login as staff, parse `Set-Cookie`, confirm `domain=.memesh.co.il` in prod-config and absent in dev-config.
- `apps/api/test/noindex-header.test.ts` — every response (200, 401, 500) carries `X-Robots-Tag: noindex, nofollow`.

### Manual QA (rule 6, extreme pass)

Run on the Vercel preview URLs before promoting to custom domains. Then re-run on custom domains after promotion.

**Staff (`staff.memesh.co.il`):**
- Staff login (correct creds) → POS visible. Cookie present in DevTools with `domain=.memesh.co.il`.
- Staff login (wrong creds) → error shown, no cookie set.
- Expired access cookie → silent `/auth/refresh` → continues working.
- Punch a card → DB updated → punch survives a hard refresh.
- Sign out → cookies cleared, login form returns.
- View source: `<meta name="robots" content="noindex,nofollow">` present.
- `curl -I` the page: `X-Robots-Tag: noindex, nofollow` present.
- `curl /robots.txt`: returns `User-agent: * / Disallow: /`.

**Admin (`admin.memesh.co.il`):**
- SSO: sign in on `staff.`, navigate to `admin.`, no re-login required.
- Sign in as `role=staff` (not admin) → "אין הרשאה" screen with link back to `staff.`.
- Sign in as `role=admin` → admin dashboard loads.
- All admin flows that worked in the old monolith still work (customers list, cards, reports, settings).
- Same noindex checks as staff.

**Customer (`my.memesh.co.il`):**
- OTP login (existing phone) → cards visible.
- OTP login (unknown phone) → handled per existing copy.
- Expired 7-day cookie → drops to signed-out, OTP again, works.
- No staff/admin pixel reachable from any path.
- Same noindex checks.

**API (`api.memesh.co.il`):**
- `curl https://api.memesh.co.il/health` → 200.
- `curl -H 'Origin: https://evil.example' https://api.memesh.co.il/auth/me` → CORS reject.
- `curl -H 'Origin: https://my.memesh.co.il' https://api.memesh.co.il/me/cards` (with valid cookie) → 200.
- `curl -I https://api.memesh.co.il/health` → `X-Robots-Tag: noindex, nofollow`.

**Cross-domain sanity:**
- `/api/admin/*` from `my.memesh.co.il` with only a customer cookie → 401.
- `/me/cards` from `admin.memesh.co.il` with only a staff cookie → 401.
- Logged in on `staff.`, visit `my.` → no auto-login as customer. OTP flow.

If any of these regresses, do not promote to production. Roll back the affected Vercel project to the prior deploy.

## Risks (rule 12 honest take), ranked

1. **Cookie-domain widening goes wrong on cutover.** The single most likely outage source. Today's customers have origin-scoped `customer_token` cookies. The moment we deploy the new API with `domain=.memesh.co.il`, the *server* is happy but the *browser* still holds the old-scope cookie. The browser sends both on subsequent requests; Set-Cookie with the broader scope creates a new cookie alongside the old one, and depending on path/expiry browser behavior you can get duplicate cookies that confuse the API. **Mitigation:** the API's cookie-clear logic must `Set-Cookie name=...; Max-Age=0; Path=/` *without* a `domain` first (clears the old origin-scoped one), then set the new one with `domain=.memesh.co.il`. Validate in staging. This is the bug I would prioritize finding before promotion.
2. **Drift between four projects' shared secrets.** `JWT_SECRET` mismatched between API and any frontend's `VITE_API_URL` host = silent verification failure. **Mitigation:** put shared secrets in Vercel team-level env (Vercel supports team-shared secrets). Document the dependency.
3. **DNS/HTTPS race during cutover.** Adding four CNAMEs + waiting on cert issuance can leave a 15–30 min window where one subdomain 404s. **Mitigation:** stage on Vercel preview URLs first; do the DNS work during low-traffic hours; verify each cert before announcing.
4. **CORS bug eats a day.** A wrong origin string (trailing slash, wrong scheme) and every prod request fails. **Mitigation:** the `[api cors reject]` log line is the difference between 10 minutes and 10 hours of debugging. Add it before phase 6.
5. **`AdminApp.tsx` import-path break.** During the move, a path that resolves loosely in TS could hide a bug. **Mitigation:** `tsc --noEmit` must pass at every commit. Never `// @ts-ignore` past an import error.
6. **Vercel project ownership confusion.** Four similarly-named projects. A wrong `vercel deploy` from the wrong directory pushes the wrong bundle to the wrong domain. **Mitigation:** only deploy from each `apps/*` directory; add an explicit `predeploy` script that prints `[deploy staff]` / `[deploy admin]` / `[deploy customer]` / `[deploy api]` so you see it in the terminal before confirming.

The honest summary: this is more work than the 2-subdomain plan, and the cookie-domain widening is where production accidents will live. The infrastructure cost (four Vercel projects, four deploy lanes, one set of shared secrets to keep in sync) is permanent, not one-time. If the goal is operational separation between staff and admin terminals — and it sounds like it is — the cost is worth it. If the goal was only "cleaner URLs," it isn't. Worth re-confirming before phase 1.

## Open questions

- **Cookie cleanup migration.** Concrete shape of the "clear old, set new" cookie migration in phase 2 — needs a brief design before coding. Specifically: do we clear-then-set on every login, or only on first login post-cutover? My current preference is "clear-then-set on every login for the first 30 days, then drop the clear", but worth a short discussion.
- **Existing prod project repurposing.** Plan assumes we rename `memesh` → `memesh-staff` to preserve deploy history. Alternative: leave `memesh` untouched as a redirect-only project that 308s everything to `my.memesh.co.il`. Cleaner but adds a fifth project. Defer decision to phase 6.

## Acceptance criteria

- `staff.memesh.co.il`, `admin.memesh.co.il`, `my.memesh.co.il`, `api.memesh.co.il` all return 200 with valid TLS and `X-Robots-Tag: noindex, nofollow`.
- An admin signed in on `staff.` is automatically signed in on `admin.` (SSO via cookie scope).
- A staff-role user signed in on `staff.` sees an "אין הרשאה" screen on `admin.`.
- A customer signed in on `my.` cannot see any staff or admin surface from any URL on `my.`.
- A bad customer deploy can be rolled back without redeploying staff, admin, or the API (verified by one synthetic rollback on staging).
- `pnpm -r build && pnpm -r test && pnpm -r typecheck` green from repo root.
- Manual QA checklist above fully ticked on the live custom domains.
- After 7 days, `site:*.memesh.co.il` (excluding apex) returns zero Google results.
- `memesh-brief-v3.md` updated to reflect the new topology.
