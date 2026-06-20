---
title: Split admin/staff and customer personal area onto separate subdomains
date: 2026-06-19
status: proposed
owner: Yoav
---

# Split admin/staff and customer personal area onto separate subdomains

## Goal in one sentence

Cleanly separate the staff/admin surface (`admin.memesh.co.il`) from the customer personal area / אזור אישי (`my.memesh.co.il`) so they are independently deployed, independently failable, and visibly different products to the people who use them — while still sharing the same backend, the same database, and the same brand layer underneath.

## Why this is worth doing now

The two surfaces are already logically separate in the code: two session providers (`StaffSessionProvider`, `CustomerSessionProvider`), two cookie families (`access_token`/`refresh_token` vs `customer_token`), two distinct API surface areas (`/auth/*`, `/admin/*`, `/staff/*`, `/customers/*`, `/punch/*`, `/cards/*` for staff; `/customer-auth/*` and `/me/*` for customer). They are glued together only by:

- one Vite shell ([apps/web/src/App.tsx](apps/web/src/App.tsx)) that switches a header tab between three surfaces,
- one Vercel project, one bundle, one domain.

That glue is the problem. A customer who clicks the wrong header tab can see a staff login form. A bad admin deploy takes the customer area down with it. The customer downloads ~3000 lines of admin code they will never use. There is no per-surface analytics or observability. The QA bar for a "customer-only" change has to include "did anything break in admin," and vice versa.

This split removes all of that for a tractable amount of work because the seam already exists.

## Goals

1. `admin.memesh.co.il` — staff POS + admin, one Vercel project, its own deploy lifecycle.
2. `my.memesh.co.il` — customer personal area only, one Vercel project, its own deploy lifecycle.
3. `memesh.co.il` (apex) — stays as marketing/landing (kept as-is or a thin placeholder).
4. Shared backend: both frontends call the same `@memesh/api` against the same DB.
5. Shared brand and shared client base lifted into `packages/*` so neither app duplicates them.
6. A bad customer deploy cannot break admin, and vice versa.
7. The split is invisible to a brother-as-product-owner: cookies survive, links work, no data is migrated.

## Constraints

- Brother is the product owner; no hard deadline, but every shipped step must keep the system fully working.
- Node 24, pnpm 10, Vite 6, React 19, Fastify on Vercel Functions (Fluid Compute). No framework swap.
- Same `@memesh/api` package and bundling pipeline (`scripts/build-api-bundle.mjs`) — don't touch the API code unless cookie scope forces it.
- Hebrew-first, RTL-first. The apex marketing site (whenever it ships) inherits this rule.
- Vercel-native infrastructure (current project is on Vercel team `team_dpfv79FB24k9MGaoi3DELiOe`, project `prj_sdAYDj5KEpM0H31dTDod5JAh0A9H`).
- Phase 1 (this plan) does the split. No new features. No refactoring of `AdminApp.tsx` (2568 lines) or `PosApp.tsx` (1634 lines) — those move whole.

## Requirements (who/what/when)

- **Staff** lands at `admin.memesh.co.il`, sees the staff login form, then the POS or admin surface based on role. The current header tab between staff/customer/admin is gone — customer is not a thing here anymore. Staff/admin tabs (or a left nav) remain.
- **Customer** lands at `my.memesh.co.il`, sees the OTP login flow, then their punch cards / activities. Never sees an admin or staff surface.
- **Marketing visitor** lands at `memesh.co.il`, sees the public landing page, and finds an obvious "אזור אישי" link to `my.memesh.co.il`. The landing page is out of scope for this plan; the requirement is only that we don't break it.
- **Both frontends call the same backend** at the same database. A punch added by staff is visible to the customer immediately.

## Out of scope (deliberately)

- Apex landing page redesign or migration.
- Any refactor of `AdminApp.tsx` or `PosApp.tsx`. They move whole, untouched.
- Splitting the backend. There is one Fastify app, one bundle, one DB. (See "Backend topology" for nuance on where the bundle is deployed.)
- AccuPOS integration changes (per the locked-decisions memory).
- New auth flows. We keep the existing staff JWT + customer cookie scheme exactly.
- Adding a customer refresh token. The current 7-day cookie semantics stay (`apps/web/src/lib/api.ts:38-43`).

---

## Chosen approach

**Two Vite apps under one monorepo, two Vercel projects, shared backend deployed alongside one of the frontends, shared code lifted into `packages/*`.**

Layout after the split:

```
apps/
  admin/                      # was: apps/web (staff + admin surface only)
    src/
      pos/                    # moved from apps/web/src/pos
      admin/                  # moved from apps/web/src/admin
      App.tsx                 # rewritten: no customer tab, just staff/admin
      lib/
        staff-session.tsx     # moved from apps/web/src/lib
        api/
          admin.ts, auth.ts, cards.ts, customers.ts, punch.ts, staff.ts
    api/server.ts             # Vercel function — bundled Fastify, identical to today
    scripts/build-api-bundle.mjs
    vercel.json
    package.json
    vite.config.ts

  customer/                   # new
    src/
      CustomerApp.tsx         # moved from apps/web/src/customer/CustomerApp.tsx
      App.tsx                 # thin shell, RTL, no tab switcher
      lib/
        customer-session.tsx  # moved from apps/web/src/lib
        api/
          customer-auth.ts, me.ts
    api/server.ts             # same Vercel function (see Backend topology)
    scripts/build-api-bundle.mjs
    vercel.json
    package.json
    vite.config.ts

  api/                        # unchanged; the Fastify source
  marketing/ (later)          # placeholder; not in scope for this plan

packages/
  brand/                      # new — Logo, Sun, FauxQr, PunchCard, shared CSS tokens
    src/index.tsx
  web-shared/                 # new — base API client + shared utils
    src/
      api.ts                  # the shared fetch wrapper
      formatting.ts           # fmtDate etc.
  auth/                       # unchanged
  db/                         # unchanged
  qr-engine/                  # unchanged
  sms/                        # unchanged
```

### Backend topology (the one real decision left)

The Fastify app gets bundled by `apps/web/scripts/build-api-bundle.mjs` and shipped as a Vercel function alongside the frontend it serves. After the split, each frontend project's `vercel.json` rewrites `/api/:path*` to its own function. Two viable shapes:

**Option A (default for Phase 1): each frontend ships its own copy of the API function.**

- `apps/admin/api/server.ts` and `apps/customer/api/server.ts` are byte-identical wrappers around the same bundled Fastify app.
- Customer fetches `https://my.memesh.co.il/api/me/cards` → that project's function → same DB.
- Staff fetches `https://admin.memesh.co.il/api/admin/*` → that project's function → same DB.
- Same-origin from each frontend. No CORS. Cookies stay `path=/`, `sameSite=lax`, no `domain` attribute — works unchanged.
- Cost: identical API code shipped from two deploys. Functionally fine on Fluid Compute (cold starts are cheap and reused; the same code is just running in two project slots).
- Drift risk: zero, because both projects build from the same `apps/api/src` and the same bundle script.

**Option B (Phase 2, when we add webhooks / cron / AccuPOS sync): split the API to `api.memesh.co.il` as a third Vercel project.**

- Single canonical API URL for external integrations.
- Requires: cookies become `domain=.memesh.co.il`, prod CORS becomes an allowlist of the two frontend origins, frontends set `VITE_API_URL=https://api.memesh.co.il`.
- `sameSite=lax` is still correct because `*.memesh.co.il` are same-site under one eTLD+1 — cookies survive subdomain hops on same-site requests, including credentialed fetches with `credentials:'include'` (which the client already does, [apps/web/src/lib/api.ts:114](apps/web/src/lib/api.ts#L114)).
- Deferred because: no integration today actually needs a stable API URL; the cost of CORS + cookie-domain debugging during the split itself is real; we can always promote later without changing the frontends.

**Decision: do Option A in this plan. Open a separate plan for Option B when an integration demands it.**

## Alternatives considered and rejected

### Alt 1: One Vite app, route by hostname

Keep `apps/web` as-is. At boot, pick the surface from `window.location.hostname` instead of the header tab.

- Pro: smallest diff, ships in a day.
- Con: still one bundle, one deploy, one failure mode. Customer downloads admin code unless we lazy-split. Cookies are easier (single origin per surface).
- **Rejected because**: it does not match the stated goal ("I don't want them in the same system"). It is the same system with a hostname check, which is the worst of both worlds — the user-facing illusion of separation without the operational benefit.

### Alt 2: One Vercel project, multi-zone routing

Two Vite outputs under one Vercel project. Use [Vercel Microfrontends](https://vercel.com/docs/microfrontends) or path/host rewrites to route the two subdomains to two builds.

- Pro: one env-var surface, one team, one billing line.
- Con: a bad deploy still affects both surfaces atomically. Microfrontends adds machinery that pays off at much larger scale than two surfaces in one repo.
- **Rejected because**: blast-radius isolation was an explicit goal. Microfrontends is the wrong tool at this size.

### Alt 3: Three projects from day one (admin + customer + api)

Do Option B above immediately as part of this split.

- Pro: ends in the "right" shape sooner.
- Con: doubles the surface area of the cut. CORS + cookie domain + DNS + env var split all happening at the same time as the file moves. Every bug during the cut becomes harder to localize.
- **Rejected because**: rule 6 (extreme QA after every step) is much easier to satisfy when one variable changes at a time. Phase 1 is "two frontends, shared API shipped twice." Phase 2 is "promote the API to its own subdomain." Sequential is cheaper than parallel here.

## Phased execution

Each phase ends with a green app at every URL we care about. No phase leaves the system half-broken.

### Phase 0 — Pre-flight (no code yet)

- [ ] Confirm Vercel team has room for at least one more project (free/pro plans cap by team).
- [ ] Confirm DNS for `memesh.co.il` is on a registrar/DNS host we can edit to add `admin.` and `my.` records.
- [ ] Confirm the current production project `memesh` is the one that backs `memesh.co.il` (or whichever domain it serves today).
- [ ] Snapshot DB before any deploys (per security rule — always have a known-good state to roll back to). Memory says DB is Vercel-Neon; take a Neon point-in-time mark.

### Phase 1 — Lift shared code into `packages/*`

Move the truly shared bits out of `apps/web/src` so both new apps can consume them without copying.

- [ ] Create `packages/brand` with `Logo`, `Sun`, `FauxQr`, `PunchCard` and the shared color tokens (currently inline in `brand.tsx`, `App.tsx`, etc.). Export typed React components.
- [ ] Create `packages/web-shared` with:
  - The shared API fetch wrapper from [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts).
  - Shared formatting utilities (`fmtDate` from `mock.ts`).
- [ ] Update `apps/web` to import from `@memesh/brand` and `@memesh/web-shared`. Build, test, no behavior change.
- [ ] Commit. App still has the three-tab header. Nothing user-visible has changed.

### Phase 2 — Carve out `apps/customer`

- [ ] Create `apps/customer` with its own `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `scripts/build-api-bundle.mjs`, `api/server.ts`, `vercel.json`. Copy the bundle script and Vercel function verbatim from `apps/web`.
- [ ] Move `apps/web/src/customer/CustomerApp.tsx` into `apps/customer/src/CustomerApp.tsx`.
- [ ] Move `apps/web/src/lib/customer-session.tsx` and `apps/web/src/lib/api/customer-auth.ts`, `me.ts` (and their tests) into `apps/customer/src/lib/`.
- [ ] Write `apps/customer/src/App.tsx`: thin RTL shell, brand header, no tab switcher, mounts `CustomerSessionProvider` + `CustomerApp`. Hebrew, RTL, no AI-generated visual tells.
- [ ] Wire `apps/customer/package.json` scripts: `dev` (port 3001), `build`, `test` (running only the customer-side tests that were under `apps/web`).
- [ ] Local sanity: `pnpm --filter @memesh/customer dev`, verify OTP login → cards view works end to end against the existing API.
- [ ] Leave `apps/web` alone for now. Customer still also lives there during the transition.
- [ ] Commit.

### Phase 3 — Carve out `apps/admin`

- [ ] Rename `apps/web` → `apps/admin` (or create `apps/admin` and move files; keep history with `git mv`).
- [ ] Drop the customer surface from `apps/admin/src/App.tsx`: remove `customer` from the `Surface` type, the tab from `TABS`, the `CustomerSessionProvider` wrap, the `surface === 'customer'` branch. The header tabs now only switch staff ↔ admin (and that switch already gates on `requiresStaffAuth`).
- [ ] Delete `apps/admin/src/customer/`, `apps/admin/src/lib/customer-session.tsx`, `apps/admin/src/lib/api/customer-auth.ts`, `apps/admin/src/lib/api/me.ts` (and their tests). They live in `apps/customer` now.
- [ ] Update `apps/admin/package.json`: change `name` to `@memesh/admin`, drop customer test files from the `test` script.
- [ ] Update root `vercel.json` to point to the admin app (`buildCommand` and `outputDirectory`) OR (preferred) move the build config into `apps/admin/vercel.json` and treat root as a no-op.
- [ ] Local sanity: `pnpm --filter @memesh/admin dev`, staff login → POS → punch a card. Then sign in as admin → customers list works.
- [ ] Commit.

### Phase 4 — Wire two Vercel projects

- [ ] Create a second Vercel project (suggested name: `memesh-customer`) and link it to `apps/customer` via root directory in project settings. The first project (currently `memesh`) gets root directory pointed at `apps/admin` and renamed to `memesh-admin`.
- [ ] Each project gets its own env vars. Both share: `DATABASE_URL`, `SERVER_SECRET_KEY`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_CUSTOMER_AUDIENCE`, SMS provider creds. Keep them in sync via `vercel env pull` into each app's `.env.local`.
- [ ] Add the two custom domains: `admin.memesh.co.il` → memesh-admin project, `my.memesh.co.il` → memesh-customer project. Apex stays on whatever serves it today.
- [ ] Verify HTTPS issuance for both subdomains.
- [ ] Smoke-test on Vercel preview URLs first, then promote to the custom domains.

### Phase 5 — Verify and harden

- [ ] Full QA pass per rule 6 — golden path + edge cases for both surfaces, see Testing section.
- [ ] Add a one-line "אזור אישי" link on `apex/marketing` (when whoever owns that site is ready). Out of scope to actually build the marketing site here.
- [ ] Update `memesh-brief-v3.md` to reflect the new topology.

---

## Security (rule 13)

Anything that touches auth or cookies during a domain split is where production accidents live. Walking the surface:

- **Cookie path/scope.** Today: `path=/`, `sameSite=lax`, `secure=isProd`, no `domain`. Because Phase 1 keeps the API same-origin to each frontend (Option A above), this stays unchanged and works. **Do not** add `domain=.memesh.co.il` in Phase 1 — that would broaden the cookie scope before it's needed and is hard to narrow back later. Phase 2 reintroduces the `domain` attribute deliberately.
- **CORS.** Today: prod is `origin: false`, dev is `origin: true`. Phase 1 keeps this. Phase 2 (separate API origin) must move prod to an explicit allowlist of exactly `['https://admin.memesh.co.il', 'https://my.memesh.co.il']` with `credentials: true`. Never `origin: '*'`.
- **Cross-surface session leakage.** With one API today, a customer who somehow ends up at `admin.memesh.co.il` and signs in as customer carries a `customer_token` cookie — but no admin route accepts it; the staff middleware reads `access_token` and rejects. Conversely a staff cookie has no effect on `/me/*` routes which check `customer_token`. Validate this explicitly in QA: try to hit `/admin/users` with only a customer cookie and confirm a 401.
- **Phishing surface.** Splitting subdomains gives attackers a slightly fatter target (one more name to typo-squat). Mitigations: enable HSTS on both subdomains via Vercel (default), and add a `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` header on the apex once we control it.
- **CSRF.** Staff and customer endpoints use HttpOnly cookies with `sameSite=lax`. Lax blocks cross-site POSTs, which is the CSRF surface we care about. Maintain this. No relaxation in Phase 1.
- **Secret duplication.** Two Vercel projects = two copies of `JWT_SECRET` and `SERVER_SECRET_KEY`. They MUST be identical (both API copies sign and verify with the same key). Document this in `.env.example` with a sharp warning. Drift here = silent customer logouts and unverifiable staff JWTs.
- **Surface confusion in code review.** PRs that touch shared `packages/*` now affect both surfaces. Add a CODEOWNERS rule (when we get to that) and call this out explicitly in the PR template.
- **Sanity check against current best practice.** Before Phase 4 ship, re-verify the `sameSite=lax` cross-subdomain behavior via Context7 / MDN, because cookie semantics shift more than they should and our training-data memory can be wrong (rule 1).

## Observability (rule 14)

Every step in this split needs to leave a log trail dense enough to debug without a screen-share. Namespacing matches the existing `[web api]` and `[auth login]` style.

- **Build pipeline.** `[build admin]` and `[build customer]` prefixes in `apps/{admin,customer}/scripts/build-api-bundle.mjs` so a failed Vercel build is immediately attributable.
- **Boot.** Each frontend logs `[admin boot]` / `[customer boot]` on mount with `{ env, apiBase, version }`. Lets you confirm which bundle is actually running in a given tab.
- **Session resolution.** Existing `[web api]` logs already record method + path + status. Keep them. Add `[customer session]` and `[staff session]` lifecycle logs (`resolved`, `signed-out`, `refresh-attempted`, `refresh-failed`) in the session providers if not already present — verify and extend rather than reinventing.
- **Backend.** Both Vercel functions log Fastify request IDs (already configured via `genReqId: () => randomUUID()`). After the split, prefix the function's bootstrap log with `[api admin-deploy]` or `[api customer-deploy]` so we can tell which deploy emitted a given log line even though the code is identical.
- **CORS / cookie debugging anchors.** Whenever Phase 2 lands, the very first thing to add is `[api cors]` logging that records the rejecting origin on every cross-origin failure. Without it, CORS bugs eat a day.

## Settings audit (rule 15)

This split itself is infrastructure, not a user-facing feature. There is no new knob a user would want. Still, walking the surface for anything we might be hardcoding:

- **API base URL.** Already a `VITE_API_URL` env var — keep it that way per project, no UI surface.
- **"Open the other app" link.** Should admin have a link to `my.memesh.co.il` so a staff member can demo customer view? Maybe, but defer — admin staff sign in as customers in shadow accounts today, not by switching tabs.
- **Customer link to staff area.** Definitely not. No surface.
- **Defaults.** Phase 1 hardcodes nothing new. Phase 2 (when it lands) will introduce the choice of whether to send analytics events through the API or directly — that's the right time to add a `Settings → Privacy` toggle, not now.
- **No new persistent settings introduced.** No `packages/settings` work needed for this plan.

## Testing (rule 18)

Tests run after every phase, not just at the end. Bar: green relevant suite + manual run through golden path on the actual domain.

### Unit tests

- The existing `apps/web/package.json` test script runs `apps/web/src/lib/api.test.ts` + the per-feature client tests (`api/customers.test.ts`, `punch.test.ts`, `cards.test.ts`, `customer-auth.test.ts`, `me.test.ts`, `admin.test.ts`, `staff.test.ts`).
- After Phase 2: `apps/customer` ships with `customer-auth.test.ts`, `me.test.ts`, and the shared `api.test.ts` (now living in `packages/web-shared`).
- After Phase 3: `apps/admin` ships with `customers.test.ts`, `punch.test.ts`, `cards.test.ts`, `admin.test.ts`, `staff.test.ts`, and the shared `api.test.ts`.
- Root `pnpm test` must keep working — it runs `pnpm -r test` and both new apps participate.

### New tests to write

- `packages/web-shared/src/api.test.ts`: re-run the existing api-client tests against the moved code. They are pure logic; they should pass unchanged after the move. If they don't, the move was wrong.
- `apps/customer/src/App.test.tsx` (minimal): mount the shell, assert it does NOT render any staff/admin component (use a module-mock check). This catches "I accidentally re-imported AdminApp into the customer shell" — the single highest-cost mistake we can make in this split.
- `apps/admin/src/App.test.tsx` (minimal): same in reverse. Mount the shell, assert the customer surface is not reachable. The `Surface` type should be `'staff' | 'admin'` only — a compile-time guarantee.

### Manual QA (per rule 6, extreme pass)

Run on the Vercel preview URLs before promoting to custom domains. Both surfaces, golden path + at least the failure paths called out:

**Admin / staff:**
- Staff login (correct creds) → POS visible, header tab to admin works for admin role.
- Staff login (wrong creds) → "invalid_credentials" shown, no cookie set.
- Staff with expired access cookie → silent `/auth/refresh` → continues working (per [apps/web/src/lib/api.ts:139-152](apps/web/src/lib/api.ts#L139-L152)).
- Punch a card → DB updated → punch survives a hard refresh.
- Add a customer → appears in list, normalized phone format ([apps/web/src/lib/api/customers.ts](apps/web/src/lib/api/customers.ts)).
- Delete customer → list updates, cards orphan-handled correctly.
- Sign out → cookies cleared, login form returns.

**Customer / אזור אישי:**
- Customer OTP login (existing phone) → cards visible.
- Customer OTP login (unknown phone) → handled per current copy.
- Customer with expired 7-day cookie → drops to signed-out, OTP again, works.
- Customer with no cards → empty state Hebrew copy renders, no JS error.
- Customer view of a punch added by staff in real time → refresh shows it.

**Cross-domain sanity:**
- Visit `my.memesh.co.il` without a customer cookie → OTP flow.
- Visit `admin.memesh.co.il` while signed in as a customer (cookie present) → no admin access; staff login form.
- Visit `my.memesh.co.il` while signed in as staff → cookie irrelevant; OTP flow.
- Hit `/api/admin/*` on the customer subdomain with only a customer cookie → 401.

If any of these regresses, do not promote to production. Roll back to the previous Vercel deploy on the affected project.

## Risks and the honest-truth take (rule 12)

The risks that will actually bite, ranked:

1. **Drift between the two API copies in Option A.** Both projects bundle from `apps/api/src` but they bundle at different times (whenever each project deploys). A staff-only fix shipped to the admin project leaves the customer project on stale Fastify code for hours or days. Mitigation: make CI run both builds on any PR that touches `apps/api` or `packages/auth`, and prefer to deploy both projects in the same merge wave when API code changes. Best long-term fix is Phase 2 (one API). This is the single biggest reason Phase 2 should be planned, not hand-waved.
2. **Cookies in Phase 2.** When we promote the API, the cookie scope changes and every existing customer cookie issued before the change is bound to the old origin. Mitigation: on the API origin change, accept both scopes in the verifier for the cookie lifetime (7 days for customers, ~1h access + 14 days refresh for staff), then drop the old scope. This is not a Phase 1 concern, but it is now on the record.
3. **Vercel project ownership confusion.** Two projects, same team, similar names. A mis-aimed `vercel deploy --prod` from the wrong directory pushes the customer bundle to the admin domain. Mitigation: never run `vercel deploy` from the repo root — always from `apps/admin` or `apps/customer`. Add an explicit `predeploy` script that prints `[deploy admin]` or `[deploy customer]` so you see it in the terminal before confirming.
4. **DNS/HTTPS race during cutover.** Adding two subdomains in Vercel + waiting on cert issuance + DNS propagation is mundane but can leave a 15-30 minute window where one subdomain 404s. Mitigation: do the DNS work on a low-traffic window and stage on Vercel preview URLs first.
5. **AdminApp.tsx is huge and depends on a lot of shared lib code.** During the move, an import path break in `AdminApp.tsx` could be hidden by TypeScript-loose modes. Mitigation: keep `tsc --noEmit` in the build pipeline (already there in `apps/web/package.json`), and never `// @ts-ignore` past an import error during the split.

The brutally honest part: this plan looks bigger than it is. The seam already exists in code. Most of Phase 2 and 3 is `git mv` + adjusting imports. The dangerous phases are 4 (Vercel project wiring, where you can shoot the wrong domain) and 5 (the QA pass that the temptation says to skip). Don't skip 5.

## Open question worth pressure-testing

The one decision I am genuinely unsure about — and the one I will run through the LLM Council before executing if you want — is **whether to do Option A or Option B for the API in Phase 1**. The plan recommends A. The case for B is that we will probably want it anyway and doing it now amortizes the cookie/CORS work. The case for A is that it's strictly fewer moving pieces during the cut. If you want, I can `/llm-council` this specific question and bring back a verdict before Phase 1 ships.

## Acceptance criteria for "this plan is done"

- `admin.memesh.co.il` serves only staff/admin. No tab to customer view. Refreshes survive auth.
- `my.memesh.co.il` serves only the customer area. No tab to staff/admin. Refreshes survive auth.
- Both URLs point to independent Vercel projects with independent deploy histories.
- A bad customer deploy can be rolled back without redeploying admin, and vice versa (verified by doing one synthetic rollback on staging).
- `pnpm test` is green from repo root.
- Manual QA checklist above is fully ticked.
- A one-line note about the new topology is added to `memesh-brief-v3.md`.
