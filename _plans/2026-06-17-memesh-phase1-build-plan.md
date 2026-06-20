# Memesh Phase 1 Build Plan

Date: 2026-06-17
Status: Approved and in build. Backend complete + tested; all 3 frontend surfaces built on mock data and deployed to Vercel. See "Build progress / handoff" below for exactly what is done and what to do next.
Source brief: `memesh-brief-v3.md`
Design source: `memesh design files/ממש - Memesh.html` (complete interactive prototype of all three surfaces)

This plan was pressure-tested through a 5-perspective council pass. The architecture choices below carry the council's reasoning, including the alternatives we rejected and why.

---

## Build progress / handoff (last updated 2026-06-17)

The entire Phase 1 **backend** is built and tested, and all three **frontend** surfaces are built on mock data and deployed to Vercel. The next big piece is deploying the API and wiring the frontend to it (see NEXT).

### Git + tooling (read first in a new session)
- Branch: `feat/phase1-secure-core` (not merged to `main`). Latest commit at handoff: `b759926` (plus this plan update).
- Push as the repo owner: `gh auth switch --user kritix-ops` before `git push`. The repo is private; other gh accounts (e.g. yoav-prog) get a 404.
- Local commit author is set to `Yoav Mizrahi <yoav@kritix.io>` so Vercel does not block deploys (Vercel blocks commits whose author is not a Vercel team member).
- pnpm runs via corepack: `corepack pnpm ...` (pnpm is not on PATH; Node 24 + corepack are).
- Tests use `node --test` + tsx against in-process Postgres (PGlite) — no local DB needed. Run prettier via the Bash tool, not PowerShell (PowerShell mangles `**` globs).
- `.gitattributes` enforces LF.

### Done — backend (82 tests green, typecheck + prettier clean)
- `packages/db`: brief-v3 schema (customers, punch_cards, punch_card_entries, staff, scan_attempts, customer_otps, staff_actions + serial/customer-number sequences); `pg`/node-postgres client (Neon HTTP driver was replaced, it cannot hold SELECT FOR UPDATE); atomic punch (SELECT FOR UPDATE + audit + idempotency); card services (allocate serial, mint signed QR, createCustomer, createPunchCard, cancelCard); OTP store + requestOtp/verifyOtp; accounts (createStaff/listStaff, customer profile get/update, setCustomerWpUserId); reports (dashboardStats, customerDetail, dormantCustomers); action log (logStaffAction/listStaffActions). One clean migration.
- `packages/qr-engine`: HMAC-SHA256 tokens, key rotation by key_id, serial format. Payload = punchCardId|customerId|createdTs|serial.
- `packages/auth`: staff JWT access/refresh (jose), scrypt password/PIN hashing, customer session tokens on a separate audience.
- `packages/sms`: SmsProvider seam + ConsoleSmsProvider stub. Real provider (019 SMS) not wired yet.
- `apps/api` (Fastify): staff password login + refresh/me/logout/dev-login; customers register/search/detail; sell card; punch (QR token or serial fallback, rate-limited); customer OTP request/verify + session + /me + /me/cards; admin dashboard + dormant report + action log; staff management; card cancel; WP one-way sync (fire-and-forget seam, disabled until WP_* env set). Server is a `buildApp()` factory.

### Done — frontend (apps/web: Vite + React 19 + Tailwind 4, RTL, Ploni w/ Assistant fallback)
- All three surfaces on MOCK data behind a header surface switcher: Staff/POS (home, search, customer card + working punch, new customer, sell, scan), Customer area (OTP login, my cards, profile edit with phone locked), Admin (dashboard, customers, cards + filter, staff + action log, reports).
- Signature components ported: Sun, Pebble, 12-pebble PunchCard (+ compact), Logo, FauxQr (placeholder QR).
- Responsive: admin stacks nav + scrolls tables under ~1000px via `useViewport`; POS/customer use fluid auto-fit grids. Standing requirement: keep the whole app responsive on mobile + tablet (saved to memory).
- Builds + typechecks clean.

### Deployment status
- Frontend: deployed to Vercel (project `memesh`, team `kritix-ops`), serving the mock-data SPA. Build is driven by a root `vercel.json` (framework=null, build `pnpm --filter @memesh/web build`, output `apps/web/dist`) so it builds from the repo root with no dashboard Root Directory change.
- API + Postgres: NOT deployed yet.

### Decisions locked during build
- DB: self-managed Postgres container on Cloudways (not Neon). API + Postgres on a single Cloudways box.
- Frontend: Vite SPA (Next.js dropped). Staff login: password/PIN (scrypt). Customer login: phone + OTP.
- SMS: local provider (019) behind the seam; console stub for now. Clean start (no WooCommerce migration).
- Topology recommendation (pending your pick): serve frontend + API from ONE origin on Cloudways (simplest, same-origin cookies). If keeping Vercel, put it on `app.memesh.co.il` with the API on `api.memesh.co.il` so cookies stay SAME-SITE. Never the cross-site `memesh.vercel.app` -> `api.memesh.co.il` setup (third-party cookies are blocked).

### NEXT (start here tomorrow)
Deploy the API and wire the frontend to it. Both planned tasks work for either topology option:
1. **API deployment kit:** `docker-compose.yml` (api + Postgres + Redis), `.env.example`, and a seed script that runs migrations + creates the first admin staff member (so login works).
2. **Frontend API client:** a typed `api` module in `apps/web` with a configurable base URL (`VITE_API_URL`, default same-origin `/api`), cookie auth wired in, then flip each surface from mock data to live calls.

### Still deferred / pre-launch
- Real-Postgres concurrency test for the atomic punch (PGlite is single-connection; punch logic is tested, the true 2-connection race is not).
- Backups/DR runbook for the self-managed Postgres container; key-rotation runbook.
- Live 019 SMS wiring + sender-ID registration + anti-spam consent for future marketing.
- Ploni woff2 files into `apps/web/public/fonts`; WP credentials for sync.
- Merge `feat/phase1-secure-core` -> `main` when ready (Vercel Production tracks `main`, which is still the old code).

---

## 1. Goals

- Ship a standalone, secure web app that lets Memesh sell and redeem 12-entry punch cards without depending on WooCommerce for card management.
- Replace the cracked Vollstart QR system with one that cannot be forged.
- Be operable and maintainable by one developer for years.
- Keep the daily front-desk flow fast and obvious on an iPad.
- Stay lawful with Israeli personal data, including minors' data.

Success looks like: a cashier registers a customer and sells a card in under a minute, punches an entry in seconds by scanning a QR, the customer sees their balance on their phone, and the owner sees the day's numbers. No forged or double-punched cards. One bill, one box, one person can run it.

## 2. Scope

In scope (Phase 1):
- Punch cards only (product 306: 12 entries, pay for 10, one-year validity).
- Three surfaces: Staff/POS (iPad-first), Customer area (mobile-first), Admin panel (desktop).
- HMAC-signed QR, manual serial/phone fallback, atomic punch, audit log.
- Staff auth (JWT + refresh), customer auth (phone + SMS OTP, no password).
- One-way sync: every new customer becomes a WordPress user.
- SMS behind a provider abstraction (stub first, real provider later).

Out of scope (later phases, do not build now):
- Classes, online booking, single-entry tickets (still sold physically with a hand stamp).
- Online card sales via WooCommerce and the inbound WooCommerce webhook (schema leaves room for it; we do not build it).
- AccuPOS integration (payment stays manual: cashier charges in AccuPOS, then confirms in our system).
- Marketing automation (birthdays, age-based promos). Schema captures consent now; sending comes later.

## 3. Constraints

- Existing business stack stays: WordPress + Elementor + WooCommerce + Cloudflare + Redis on Cloudways.
- New customers must sync one-way to WordPress via the WP REST API.
- Security is a first-class requirement, not a later pass (see section 9).
- One developer (Yoav), comfortable with Node and TypeScript.
- Low volume: one location, a few hundred customers, hundreds to low-thousands of SMS per month.
- Hebrew, RTL throughout. No emojis anywhere (brand rule). Ploni font (licensed) with Assistant fallback.

## 4. Users and the lazy-user lens

We design for someone who will not read instructions and gives up at the first point of friction.

- Cashier on an iPad during a rush: the three primary actions (search, new customer, scan) are the biggest things on the home screen. Punching is one tap then a companion count. Selling is register, charge in AccuPOS, confirm. Tap targets are at least 44px, inputs are 16px or larger so Safari does not zoom.
- Parent on a phone: log in with a phone number and a 6-digit code, no password to forget. See remaining entries as a big number plus the pebble visual. Edit details, but phone is locked because it is the identity (only staff change it).
- Owner on a laptop: the dashboard answers "how was today" and "what is about to expire" without clicking.

Failure paths are designed in: QR will not scan (fall back to serial or phone search), customer forgot their phone (staff-assisted lookup), code did not arrive (resend with a cooldown), wrongful punch (a visible reconciliation path tied to the audit log).

## 5. Architecture decision

The repo already had a sensible skeleton, but two choices in it were wrong for this project. The decisions below correct them.

### 5.1 Database: Cloudways Postgres via the `pg` driver (NOT Neon)

`packages/db/src/client.ts` currently imports `drizzle-orm/neon-http` and calls `neon()`. The Neon HTTP driver is stateless per request and cannot hold `SELECT FOR UPDATE` across a transaction. That breaks the atomic punch, which is the single most important security guarantee in the system. It also defaults to US/EU regions, which would offshore Israeli minors' PII.

Decision: rewrite the client to `drizzle-orm/node-postgres` with a `pg` Pool against a Postgres instance we control, co-located on the Cloudways server. This gives real transactions and keeps data in-region.

Rejected: Neon serverless. Adds a second database, a second bill, a second failure domain, a data-residency problem, and a driver that cannot do the one thing we most need. The branching/multi-site upside it offers is for a Phase 2 that is out of scope.

### 5.2 Hosting: single Cloudways server with Docker Compose

One Cloudways server runs the API, the web bundle, Postgres, and Redis. The punch transaction never leaves the box. One bill, one place to look when something breaks at 9pm.

Cloudways supports Node.js and Docker as of 2026. It does not offer managed PostgreSQL (its managed DB is MySQL/MariaDB), so Postgres runs in a Docker container that we manage, which means backups and restore are our responsibility (see 9.4).

Decision (confirmed 2026-06-17): self-managed Postgres container on the Cloudways server. Still verify the current Cloudways plan has the server size and Docker/root access for this before launch; if it does not, fall back to a plain VPS in a region near Israel with full Docker control.

Rejected: split serverless (web on Vercel, DB on Neon). Two control planes, cross-network latency on a row lock, connection-pool exhaustion under a front-desk rush, a second vendor, and offshore PII. No benefit at this scale.

### 5.3 Frontend: Vite + React 19 + Tailwind 4 SPA (drop Next.js 16)

The prototype is already a client-side React app. The POS and admin sit behind auth and are app-like, so server rendering buys nothing there; the only marginal SSR benefit is the customer area's first paint, which does not justify running Next.js (a second web server) alongside Fastify for a solo developer. Next.js 16 is also very new and a churn risk for one maintainer.

Decision: build the web app with Vite + React 19 + Tailwind 4. Keep React 19 and Tailwind 4 (both stable, and the prototype is React). Serve the static bundle from the Fastify app or a sibling static server in the same Compose stack.

Rejected: Next.js 16. Overlaps Fastify, adds bleeding-edge risk, and the SSR upside does not apply to an authed internal tool.

### 5.4 App structure: one repo, two frontend entry points, hard API authz separation

The public customer area and the staff/admin area have different threat models. We keep one monorepo (shared types, QR engine, design system) but build two separate frontend bundles: a customer bundle and a staff/admin bundle. The API enforces authorization independently per route namespace with separate token audiences, so a frontend bug cannot escalate a customer into a cashier or a cashier into the till's admin functions.

This captures most of the security benefit of fully splitting the apps without doubling the work for a solo dev. A full deploy split later (separate subdomains, separate containers) becomes a config change, not a rewrite.

Rejected: a single role-gated bundle for all three surfaces. Simpler, but one auth bug exposes the till and the admin reports to the public surface. Also rejected for now: fully separate apps/repos (too much overhead for one developer at this stage).

### 5.5 Monorepo layout

```
apps/
  api/                 Fastify 5 + Drizzle + Zod + Pino + jose (exists, keep)
  web-customer/        Vite SPA: customer area (new)
  web-staff/           Vite SPA: staff/POS + admin (new)
packages/
  db/                  Drizzle schema + pg client (rewrite client + schema)
  auth/                jose JWT + refresh + OTP helpers (extend)
  qr-engine/           HMAC sign/verify + serial + key rotation (finish)
  sms/                 SMS provider abstraction (new)
  ui/                  shared design system ported from the prototype (new)
```

Stack confirmed: Fastify 5, Drizzle ORM, Zod, Pino, jose, helmet/cors/rate-limit, Vite, React 19, Tailwind 4, pg, Redis.

## 6. Data model (rewrite to brief v3)

The current schema files (`tickets.ts`, `redemptions.ts`) are from the previous plan and get replaced. New tables, from brief v3 section 4 plus the audit table from section 12:

- `customers` (id uuid, customer_number L-NNNN, wp_user_id, first/last name, phone unique, email, preferred_channel, children jsonb, internal_notes, source, status, registered_by, timestamps, plus a marketing-consent flag for future use)
- `punch_cards` (id, customer_id, wc_order_id, serial M-YYYYMMDD-NNNN, qr_token, key_id, total_entries default 12, used_entries, is_active, expires_at, source, timestamps)
- `punch_card_entries` (id, punch_card_id, punched_by, method, companion_count, idempotency_key, notes, punched_at)
- `staff` (id, name, phone, email, role admin/manager/cashier, is_active, timestamps)
- `scan_attempts` (id, qr_token_hash, result, ip_address, terminal_id, attempted_at) — hash only, never the token
- `serial_seq` Postgres SEQUENCE for the NNNN counter

Note the additions versus the brief: `key_id` on cards (for key rotation), `idempotency_key` on entries (for safe retry), and a marketing-consent field on customers.

## 7. QR security

Per brief section 12, with the operational gaps the council flagged.

- Token: `base64url(key_id + "." + payload + "." + signature)` where `payload = punch_card_id|customer_id|created_ts|serial` and `signature = HMAC-SHA256(payload, SERVER_SECRET[key_id])`.
- The QR carries no authority; the server is the only source of truth.
- Verify: decode, look up key by `key_id`, constant-time compare signature (`crypto.timingSafeEqual`), check `is_active` and `expires_at`, check `used_entries < total_entries`.
- Punch (atomic): inside one transaction, `SELECT ... FOR UPDATE` the card row, re-check entries, insert `punch_card_entry`, increment `used_entries`, flip `is_active` if exhausted. An `idempotency_key` makes a double-tap or network retry a no-op rather than a double-punch.
- Replay/abuse: rate-limit scans per IP and per terminal (Redis); after repeated failures, temporary cooldown; log every attempt (success and failure) to `scan_attempts` with a hash of the token.
- Fallback: serial lookup `M-YYYYMMDD-NNNN`, or phone lookup to a list of active cards.

## 8. Authentication

- Staff: JWT access token + refresh token (jose). Roles: admin, manager, cashier. Authorization enforced per API route namespace.
- Customer: phone + 6-digit SMS OTP, no password. OTP stored hashed with a short expiry (5 minutes), single use.
- OTP abuse defense (the council's top catch): rate-limit OTP requests per phone and per IP, cap resends with a cooldown, lock out after N failures, never reveal whether a phone exists. This endpoint is the real public attack surface and the main SMS-cost risk.

## 9. Security and safety

### 9.1 Sensitive data and residency
Names, phone numbers, children's names and birthdays are personal data under Israel's Privacy Protection Law, and children's data raises the bar. Keep all PII in-region on the Cloudways box. Do not copy production data into throwaway environments. Minimize what we store and never log OTP codes, QR tokens, or message bodies.

### 9.2 Secrets
`SERVER_SECRET` keys, JWT keys, DB and SMS credentials live in server environment/secret storage, never in code or the repo. The `qr-engine` reads keys by `key_id` so multiple keys can be active at once.

### 9.3 Key rotation runbook
Generate a new key with a new `key_id`, mark it active for new cards, keep old keys valid for verification until their cards expire. New cards sign with the newest key; existing cards keep verifying against their stored `key_id`. To respond to a compromise, deactivate the affected `key_id` and reissue those cards (new serial + token, SMS to the customer). Write this as an actual runbook in the repo.

### 9.4 Backups and disaster recovery
Because Postgres is self-managed in a container, we own backups. Nightly `pg_dump` to off-box storage in-region, plus a documented restore drill that is actually run once before launch. The single box is one failure domain; the recovery story must exist on paper and be tested.

### 9.5 Degraded network and disputes
Decide front-desk behavior when the iPad loses wifi mid-rush (at minimum, a clear error and a manual serial fallback; a queued-punch mode is a possible enhancement). Every punch writes an audit entry so a parent disputing a wrongful deduction can be reconciled by staff against the log.

### 9.6 Boundaries
Validate every input at the API with Zod. Never trust the client. Fail closed. Least privilege on staff roles. helmet, CORS allowlist, and rate limiting on by default.

## 10. SMS provider

SMS sits behind a `packages/sms` abstraction with one `send(phone, message)` method plus our own OTP logic on top. Start with a console-logging stub so the whole flow works without a vendor. Wire the real provider last.

Recommended provider (from prior research): 019 SMS, a local Israeli provider. Published OTP price about 0.02 ILS per message, no service fee, direct connections to Israeli carriers (better OTP deliverability than international routes), Hebrew sender ID, ILS invoicing. International providers (Twilio, Vonage) cost roughly 35 to 45 times more per message to Israel and route less reliably. The abstraction means swapping or adding a provider later is a one-file change.

## 11. WordPress sync

When a customer is created, create a WP user via the WP REST API (`username = phone`, email or `phone@memesh.local`, random secure password, role subscriber), then store `wp_user_id`. This runs as a fire-and-forget background job with retry, never inside the punch or checkout path, so WP being slow or down never blocks the front desk.

Phase 1 is a clean start (confirmed 2026-06-17): no existing WooCommerce customer data to migrate. The sync still creates users idempotently (look up by phone or email before creating) so a future reconciliation or an accidental re-run cannot create duplicates.

## 12. Build sequencing (de-risk the scary parts first)

1. Rewrite `packages/db`: schema to brief v3, `client.ts` to `pg` + `node-postgres`, migrations, prove a real connection to Cloudways Postgres.
2. Atomic punch transaction (`SELECT FOR UPDATE`) + `scan_attempts` audit row + idempotency, behind failing-then-passing tests. This is the only thing that can lose money or double-punch. Nail it before any UI.
3. `qr-engine`: finish HMAC sign/verify, serial generation, key rotation by `key_id`. Finish the started tests. Write the key-rotation runbook.
4. Staff auth (JWT + refresh), then the POS punch flow end to end (scan + manual fallback). This is a shippable demo for the owner.
5. Customer OTP login behind the SMS stub, with strict OTP rate-limiting and lockout. Then the customer home and profile screens.
6. Admin dashboards and management screens (read-mostly first).
7. WP one-way user sync as a retried background job.
8. Cross-cutting before launch: backups + tested restore, real 019 SMS wiring, Ploni font, Hebrew/RTL QA on iPad, security review pass.

Ship surfaces in order of who blocks revenue: staff first, customer second, admin third.

## 13. Cost flags

- Cloudways: existing. Hosting the new Node app + Postgres container may need a larger server than the current WordPress plan. Confirm the plan and any added cost before launch. Plans start around 11 USD/month and scale with server size.
- SMS: 019 at about 0.02 ILS per OTP. At low-thousands of messages a month this is roughly 20 to 60 ILS/month. Negligible, and far cheaper than Twilio/Vonage.
- Ploni font: licensed (confirmed by owner). No added cost.
- Neon avoided: no second database bill, no egress.

## 14. Alternatives rejected (summary)

- Neon serverless DB: breaks the atomic punch driver, offshores PII, second bill. Rejected.
- Split serverless hosting (Vercel + Neon): latency on the row lock, two vendors, no benefit at this scale. Rejected.
- Next.js 16 frontend: overlaps Fastify, bleeding-edge churn for a solo dev, SSR not needed behind auth. Rejected in favor of Vite SPA.
- Single role-gated app for all surfaces: one auth bug exposes the till to the public surface. Rejected in favor of two bundles + API-layer authz.
- International SMS (Twilio/Vonage): 35 to 45x cost and worse Israeli deliverability. Rejected in favor of a local provider behind an abstraction.

## 15. Open questions

Resolved 2026-06-17:
- Database hosting: self-managed Postgres container on the Cloudways server (see 5.2).
- Existing data: clean start, no WooCommerce customer migration (see 11).

Still open (do not block step 1; needed around steps 4 to 8):
1. Domain: `pos.memesh.co.il`, `app.memesh.co.il`, or separate subdomains for the customer vs staff bundles (which fits the two-bundle structure).
2. OTP validity window (recommend 5 minutes) and resend cooldown.
3. Lost-phone recovery: staff-assisted only, or email-based? (Affects whether email becomes more than optional.)
4. Staff login: OTP like customers, or user/password? (Brief leaves this open.) Needed at step 4.
5. Physical QR printing in addition to SMS: needed or not?
6. Degraded-network behavior at the front desk: is a queued-offline-punch mode in scope for Phase 1, or is a clear error plus manual fallback enough?
