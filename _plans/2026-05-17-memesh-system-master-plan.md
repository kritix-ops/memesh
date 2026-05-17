# Memesh System — Master Plan v1

**Date**: 2026-05-17
**Status**: APPROVED by Yoav 2026-05-17 — proceeding with Option A as written. LLM Council was run and recommended a smaller 3-gate approach; user reviewed verdict and chose to proceed with full plan. Council verdict preserved in §14 for the record.
**Source brief**: `C:\Projects\Memesh\memesh-super-brief-v2.docx`
**Author**: Claude (technical lead support), reviewed by Yoav (technical lead) and brother (product owner)

---

## 0. Goals

Replace Amelia Booking Pro and Vollstart Event Tickets on memesh.co.il with a custom system that unifies:

1. Online ticket and punch-card sales (via existing WooCommerce + Meshulam/Grow).
2. Physical POS redemption with offline-tolerant tablet UX, coexisting with AccuPOS / AP card-present payments.
3. Customer area with family profile, ticket QR, course bookings.
4. Staff portal covering cashiers (front desk), instructors (attendance + own schedule), managers (full ops), admin (system config).
5. Operational reports — instructor payroll, revenue, punch-card utilization, activity ROI.

Success looks like: brother's staff stops using two flaky third-party plugins and gets one fast, honest UI that handles the playground's actual day. Customers see a polished Hebrew RTL experience that doesn't feel like 2014 WordPress. Zero data loss during cutover.

---

## 1. Constraints

- ~~**Site cannot break during build**. memesh.co.il is live with paying customers.~~ **Updated 2026-05-17**: Memesh has not opened yet, memesh.co.il is dev/staging only, no real customers exist. Greenfield launch, not live-site replacement. Removes the cutover-Saturday risk entirely. Migration phase shrinks to importing whatever dev/test data exists in Vollstart/Amelia (if any).
- **No hard deadline** (per user decision 2026-05-17). Build quality wins over speed. Realistic estimate: 4–5 months single-developer, possibly faster with help.
- **Brother is product owner** — features get validated with him and his staff before being treated as done.
- **Backend language locked: Node.js + TypeScript.**
- **WooCommerce + Meshulam/Grow stay** for web payments. Not touching the checkout.
- **AccuPOS + AP stay** for card-present payments. We integrate at the edges.
- **AccuPOS Israel API exists but is gated behind payment.** Brother has already had this conversation with AccuPOS directly and will purchase API access when the integration phase needs it (confirmed 2026-05-17). Plan: build Phase 3 POS PWA with manual cashier confirmation as the working flow. When brother purchases API access (likely during/after Phase 3 once the manual flow is proven), wire up automatic payment-event reconciliation as an upgrade. AccuPOS API cost is a future line-item, not yet priced — to be confirmed by brother when he purchases.
- **Hebrew RTL throughout** — not bolted on. Customer area, staff portal, POS PWA, notifications, error messages.
- **Israeli compliance**: IS 5568 accessibility, gov data handling for minors (children's DOB is sensitive).

---

## 2. Requirements summary

(Full details in the brief. Highlights here.)

- **Tickets**: baby (₪45), child (₪55), companion-2 (₪12), 12-punch-card (₪550, 1-yr validity).
- **One entry = one child + one designated companion**. Hard invariant.
- **Online checkout caps extra companions at +1.** In-person flexible.
- **24h cancellation window** for activities, configurable per activity.
- **Hand-stamp same-day re-entry** without a second redemption.
- **HMAC-SHA256 QR** with `key_id` rotation field. ~128-char tokens.
- **Roles**: Admin / Manager / Instructor / Cashier / Customer.
- **Notifications**: ticket purchase, course confirmation, course reminder 24h, cancellation, waitlist freed, punch-card 3-left, punch-card 30-days-to-expiry, optional birthday.

---

## 3. Build-approach options

### Option A — Full custom build, phased (RECOMMENDED)

**Summary**: Build everything in the brief as a Node+TS service + React SPA + React PWA, deployed alongside the existing WordPress site. Phased delivery with parallel runs before any cutover. ~4–5 months calendar.

**Detail**: Six sequential phases (see §5). Each phase ships something usable and validated with brother's staff. Migration runs in parallel — Vollstart and Amelia stay live, new system runs in shadow mode until Phase 5 beta. Cutover only after real users have validated the new system end-to-end.

**Why recommended**: matches the brief exactly, gives brother full control of the IP, no ongoing SaaS fees beyond infra. The phased structure protects the live site — at every point if something breaks we can roll back to the old plugins because they're still installed. Cost predictable, ceiling controlled.

**Risks**: ongoing maintenance burden falls on us. Brother needs to be available for regular validation cycles or the product drifts.

### Option B — Hybrid: replace Vollstart now, defer Amelia

**Summary**: Same architecture as A, but Phase 4 (activities + staff portal) is split off and shipped 2–3 months after cutover. Cutover happens after tickets + customer area + POS are done (~3 months).

**Detail**: Vollstart is the more painful plugin (security model is broken, brief §4). Amelia for course bookings is annoying but functional. Get the tickets right first, run on the new system, then build courses on top once that's stable.

**Why consider**: lower risk per release, smaller blast radius at each step. Shipping value to brother in months instead of waiting 5.

**Why not picked as default**: brother has two plugins to maintain during the gap. Twice the surface area for bugs and license renewals. Migration becomes two events instead of one. Reasonable to choose if the brother feels Vollstart pain is acute and course bookings can wait.

### Option C — Buy SaaS (e.g., Bookeo, Sawyer, Acuity), skip the build

**Summary**: Adopt a kids-playground / activity-class SaaS that handles tickets + bookings + check-in. Pay $50–200/month per location. No custom code.

**Detail**: Industry has products in this space. Trade ownership, customization, and Hebrew RTL quality for speed.

**Why consider**: zero engineering time. Operational tomorrow.

**Why not picked**: (1) Hebrew RTL quality is usually awful on US-built SaaS — the lazy-user bar from CLAUDE.md rule 10 won't be met. (2) AccuPOS integration is non-existent on these platforms. (3) Punch-card semantics + companion rules + hand-stamp logic won't match. (4) Ongoing per-month cost grows with the business. (5) The brief is specific to a Hebrew, Israeli, AP/Meshulam-integrated playground; off-the-shelf doesn't fit.

### Recommendation

**Option A** — full custom phased build. The brief is detailed enough and specific enough that SaaS doesn't fit, and the no-hard-deadline decision removes the only good reason to split into Option B. Move with A unless brother flags that he can't wait 4–5 months for activities, in which case fall back to B.

---

## 4. High-level architecture

(Detail in brief §2. Locked since user decision 2026-05-17.)

- **Backend API**: Node.js 24 LTS + TypeScript + Express or Fastify. Fastify preferred for type-first ergonomics and lower overhead.
- **Database**: PostgreSQL 16 (Neon serverless, EU region — closest to Israel and avoids server management).
- **Cache + Queue**: Redis (Upstash, EU region, serverless).
- **Customer SPA + Staff Portal**: React 19 + TypeScript + Vite + Tailwind RTL preset.
- **POS PWA**: React + service worker + IndexedDB for offline.
- **Auth**: JWT access + refresh, WordPress SSO bridge.
- **Email**: Resend (Hebrew RTL templates).
- **SMS**: Israeli local gateway (InforUMobile or Cellact) — NOT Twilio. See cost analysis.
- **Deployment**: Vercel for frontends + API (Fluid Compute supports Node 24 with long timeouts, integrates cleanly with Neon/Upstash). WordPress stays on Cloudways.
- **Observability**: structured logging from day one (per CLAUDE.md rule 14) — namespaced console.info on frontend, pino on backend, Better Stack or Logtail for aggregation.

---

## 5. Phased delivery plan

### Phase 0 — Discovery & validation (1–2 weeks)

- Audit current WP site, plugins, DB, Vollstart + Amelia data.
- ~~Direct call to AccuPOS Israel (077-2304880) to confirm API availability.~~ **Resolved 2026-05-17: brother owns the AccuPOS relationship, will purchase API access when integration phase needs it.**
- Sit with brother + at least one cashier + one instructor; observe 2-3 days of real operations.
- Measure real volumes: tickets/month, SMS/month, peak concurrency, average punch-card age, course capacity utilization.
- Confirm Meshulam/Grow webhook reliability.
- Decide: when in Phase 3 brother triggers AccuPOS API purchase (target: once manual flow is proven and integration is the next bottleneck).
- Output: Phase 0 report, locked stack, validated requirements doc.

### Phase 1 — Backend foundation (3–4 weeks)

- Repo bootstrap (monorepo: `apps/api`, `apps/customer-spa`, `apps/staff-portal`, `apps/pos-pwa`, shared `packages/`).
- Postgres schema (Drizzle ORM or Prisma — pick one).
- Auth: JWT issue/refresh + WP SSO bridge via WP plugin (existing memesh-customer-area can be model).
- QR engine: HMAC-SHA256 signing + `key_id` rotation + serial generator.
- Webhook receiver for WooCommerce `order_completed`.
- Observability infrastructure: structured logs, request IDs, error reporting (Sentry).
- Settings layer baseline (config table, admin UI scaffolding).
- Security baseline: rate limiting, input validation (Zod schemas), secrets via env, OWASP basics.

### Phase 2 — Tickets + Customer Area read-side (3–4 weeks)

- Ticket model end-to-end: creation from WC webhook, QR display, history.
- Customer SPA: login, dashboard, my-tickets, my-orders, profile (no edits yet).
- Migration script v1: import Vollstart active punch-cards into new system, in shadow mode (old plugin still authoritative).
- Reconciliation job: nightly compare old plugin state to new system, alert on drift.
- Hebrew RTL design system locked (Heebo or Rubik + Inter, Tailwind RTL preset, gov.il-influenced patterns).
- Notifications: ticket-purchased email + SMS, basic templates.

### Phase 3 — POS PWA (3–4 weeks)

- React PWA installable on AccuPOS Android tablets.
- Cashier auth (pin-based for speed).
- Three redemption methods: QR scan, serial lookup, phone+name search.
- Online ticket redemption flow: scan → verify → confirm companions → redeem.
- Offline mode: IndexedDB queue, sync on reconnect, conflict detection at server.
- Manual ticket creation flow (in-person sale): cashier creates ticket → cashier confirms AccuPOS payment manually → ticket activates → QR shown + SMS sent.
- POS-side observability: every action logged client-side AND server-side with `pos_terminal_id`.

### Phase 4 — Activities + Staff Portal (3–4 weeks)

- Activity / Session / Booking / Waitlist / Attendance models.
- Customer SPA: course browsing, booking, my-bookings, cancel (24h rule), waitlist join.
- Staff portal:
  - Instructor view: my-schedule, my-roster-per-session, mark-attendance.
  - Manager view: full schedule, activity CRUD, instructor management.
  - Cashier view: in-person course enrollment.
- Migration script v2: Amelia bookings → new system.
- Notifications: booking confirmation, 24h reminder, cancellation, waitlist freed.
- Instructor payroll report (CSV export).

### Phase 5 — Parallel run + Beta (2–3 weeks)

- 5–10 friendly families opt into new customer area.
- 1 cashier shift per day uses new POS for online-purchased ticket redemption (Vollstart still authoritative for in-person sales).
- Real-world bug bash, brother + staff feedback loop, UX polish.
- Daily reconciliation reports.
- Settings audit: every feature reviewed against CLAUDE.md rule 15.
- Accessibility audit against IS 5568 (rule 13).

### Phase 6 — Cutover (1 week, planned)

- Communicate to all customers (Email + SMS) — what's changing, what to expect, support contact.
- Lock writes on Amelia + Vollstart in a planned window (mid-week, low-traffic).
- Final migration pass + reconciliation.
- Switch WC webhook target to new system.
- Decommission Amelia + Vollstart admin UI (keep DB tables for 90 days).
- Heightened on-call for first 7 days.

### Phase 7 — Cleanup + iterate (ongoing)

- Remove old plugin DB tables (after 90-day cooling period).
- Performance tuning based on real traffic.
- Feature requests from brother + staff.
- Tighten observability dashboards based on real incidents.

---

## 6. Security plan (CLAUDE.md rule 13)

- **Sensitive data**: customer PII (name, email, phone), children PII (name, DOB) — only with explicit consent, separate consent flag, never logged.
- **Secrets**: `SERVER_SECRET_KEY` for HMAC in env, rotate via `key_id` mechanism. Never committed.
- **JWT**: short-lived access (15 min) + long refresh (7 days, rotating). HttpOnly cookies for refresh.
- **Auth boundaries**: role checks at API middleware level, not in route handlers. Cashier cannot escalate. Customer cannot view other customer's tickets.
- **Input validation**: Zod schemas at every API boundary. Reject unknown fields.
- **SQL**: parameterized queries only (Drizzle/Prisma enforces). No string concat.
- **QR**: signature mandatory, payload + signature must validate, replay protection via `redemption.is_offline_sync` collision detection.
- **POS PWA**: scoped JWT (cashier-only role), pin-based unlock for cashier switching, idle timeout.
- **Rate limiting**: per-IP and per-user, especially on auth and QR-verify.
- **Audit log**: every state-changing action (redeem, cancel, refund) writes an immutable audit row.
- **Backups**: Neon point-in-time recovery (built-in, free tier 24h, paid 7-day+). Off-site nightly snapshot to S3-compatible storage.
- **OWASP**: top 10 review at end of each phase.
- **Israeli law**: data on minors handled per Privacy Protection Law (children PII opt-in, not opt-out).

---

## 7. Observability plan (CLAUDE.md rule 14)

- **Frontend**: namespaced `console.info('[area step] description', { values })` at every meaningful step. Areas: `[auth login]`, `[ticket render]`, `[pos scan]`, `[pos sync]`, `[booking submit]`, etc. Values are real (booleans WITH context, not just "happened").
- **Backend**: pino structured JSON logs, request ID propagation, key events: webhook received, QR verified, redemption created, sync conflict, payment confirmed.
- **Logs aggregator**: Better Stack or Logtail. Searchable, alertable.
- **Sentry**: error reporting both sides, source maps.
- **Metrics dashboards**: tickets sold/day, redemptions/day, sync conflicts/day, failed QR verifications/day, course fill rate.
- **Alerts**: webhook failure, reconciliation drift, sync conflict count over threshold, AccuPOS terminal offline > 30 min during business hours.

---

## 8. Settings plan (CLAUDE.md rule 15)

A settings layer is established in Phase 1 (`settings` table + admin UI). Every feature ships with an explicit Settings section identifying:

- **Which knobs are exposed** to admin/manager (e.g., 24h cancellation window length, punch-card validity duration, low-balance alert threshold, "do we send birthday emails", booking-reminder hours, max companion add-on online).
- **Which knobs are NOT exposed and why** (e.g., HMAC algorithm is not configurable — security invariant).
- **Defaults** (and rationale).
- **Grouping** (Tickets / Activities / Notifications / Security / Display).

No hardcoded business numbers in code. All thresholds/timings/limits resolve from settings table with sensible defaults.

---

## 9. UI/UX bar (CLAUDE.md rules 5, 10, 16)

- **Hebrew RTL native** — every screen designed RTL-first, not flipped.
- **Typography**: Heebo or Rubik for Hebrew, Inter for Latin numerals/codes. Generous spacing, clear hierarchy.
- **Customer area**: must work on mobile (most customers will check on phone). Dashboard fits one screen on iPhone SE without scrolling for the "do I have a ticket today" question.
- **POS PWA**: optimized for tablet landscape, one-thumb-reachable primary actions for cashier behind counter. Big touch targets, no menus deeper than 2 levels.
- **Staff portal**: instructor mark-attendance flow must work in under 30 seconds for a class of 12 kids.
- **Plain Hebrew copy** — no jargon, no AI-tells (per rule 5: no em dashes, no "ניתן לציין", no rhythmic three-item lists). Brief, specific, human.
- **States designed explicitly**: loading, empty, error, success — every screen, every interaction.
- **Accessibility**: IS 5568 compliance, NVDA + VoiceOver tested.

---

## 10. Costs (CLAUDE.md rule 8)

Verified 2026-05-17. Prices vary, recheck before commit.

| Item | Monthly cost | Notes |
|------|------|------|
| WordPress hosting (Cloudways, existing) | ~$14 | No change. |
| Backend API hosting (Vercel Fluid Compute, Pro plan) | ~$20–40 | Free tier may suffice early; Pro for production. |
| Neon Postgres (Launch tier) | ~$15–50 | Depends on compute usage. Free tier covers dev. |
| Upstash Redis (Pay-as-you-go) | ~$5–15 | Free tier covers small volume. |
| Resend email (Pro) | $20 | 50K emails/month. Free tier (3K) covers small start. |
| SMS — Israeli local gateway (InforU/Cellact) | ~₪40–200 (~$11–55) | At ₪0.08/SMS, 500–2500 SMS/month range. **Per-message rate must be confirmed with provider.** |
| SMS — Twilio (if chosen, NOT recommended) | $128–515 | At $0.2575/SMS, 500–2000 SMS/month. ~10× cost of local gateway. |
| Sentry (error reporting) | $0–26 | Free tier covers small volume. |
| Logtail / Better Stack | $0–25 | Free tier covers small volume. |
| **Total realistic monthly run-cost** | **~$70–180/month** | At full traffic, excluding WP hosting which stays the same. |

**The cost story**:
1. Use Israeli SMS gateway (InforUMobile / Cellact). Twilio is 10× more expensive for Israel-only traffic.
2. Use Vercel + Neon + Upstash rather than self-hosting Postgres on Cloudways. Less ops, cheaper at this scale.
3. Migration is not free — expect $0 for tools but ~2 weeks dev time.

**Build cost**: This is the elephant. 4–5 months of work. If Yoav is doing it himself, that's his time. If outsourcing/partnering, that's a real budget item that needs its own conversation with brother before committing.

---

## 11. Open questions blocking start

1. **Brother sign-off** on Option A (full custom phased) vs Option B (defer activities). Need a 1-hour sit-down with him before Phase 0.
2. **AccuPOS API existence** — confirmation call required. If API exists, design changes. Default to manual confirmation flow.
3. **Real volumes** — tickets/month, SMS/month, peak concurrent customers — measured during Phase 0, not estimated.
4. **Hosting boundary** — keep all on Cloudways (existing relationship) vs move backend to Vercel (modern PaaS, better DX). Default to Vercel for backend if Cloudways doesn't ergonomically support Node 24 containers.
5. **Children's data consent** — confirm with brother how the playground handles children's data today, what consent the customer signs, what we're allowed to store.
6. **Refund policy** — partial-use punch cards, course cancellation refunds, expired tickets. Not in brief.
7. **Multi-location future** — is brother planning a second location? If yes, multi-tenancy bakes in cheap now and expensive later.

---

## 12. Alternatives rejected

- **WordPress-native (PHP plugin)**: rejected. Offline POS sync, real-time staff portal, fast cashier UX impossible inside WP/PHP runtime. Brief §2.2 dismissed for the same reason.
- **Python + FastAPI backend**: rejected. User chose Node+TS 2026-05-17. One language across full stack, stronger WP/WC ecosystem.
- **Twilio for SMS**: rejected on cost. $0.2575/SMS to Israel is ~10× a local Israeli gateway.
- **Single-shot rewrite ("big bang" cutover)**: rejected. Live site, paying customers, no acceptable downtime. Phased + parallel-run is mandatory.
- **SaaS replacement (Bookeo/Sawyer/Acuity)**: rejected. Hebrew RTL quality, AccuPOS integration, and punch-card semantics don't fit. Per §3 Option C.
- **Edge Functions for backend**: rejected. Per current Vercel guidance, Fluid Compute is preferred over Edge for our shape of workload (long QR verification chains, DB-heavy reads).

---

## 13. Next concrete actions

1. Yoav reviews this plan, brings to brother for product-owner sign-off.
2. Schedule brother sit-down (1 hour), walk through Options A vs B, get verbal commit.
3. Yoav calls AccuPOS Israel sales (077-2304880) to confirm API availability.
4. Once both above are done, Phase 0 starts.

---

## 14. LLM Council verdict (for the record)

A 5-advisor council was run on this plan 2026-05-17. The verdict recommended **rejecting Option A** in favor of a three-gate approach:
- Gate 1 (this week): quantify forgery loss, confirm brother consents to 10-year personal-dependency, confirm PCI scope.
- Gate 2 (2-3 weeks, if justified): HMAC tickets + scanner + dual-read importer only. No PWA, no offline, no staff portal.
- Gate 3 (60-day pause): re-justify each remaining module against "pay for the plugin vs maintain this myself for a decade."

Key council concerns:
1. The 4-5 month estimate is optimistic for a solo developer; realistic is 10-12 months with a long tail.
2. The CRC32 forgery loss has never been measured — every downstream decision rests on an unknown.
3. The cutover (importer + dual-read) is treated as Phase 6 but is actually the highest-risk part of the project.
4. Custom code creates a 10-year personal-dependency between Yoav and brother that plugin licenses don't.
5. Customer login wall hurts walk-up conversion — guest checkout (phone-number-only) is the right pattern.
6. PCI scope and Israeli Privacy Protection Law obligations for minors' PII are not addressed.
7. The "Memesh OS" multi-tenant SaaS expansion was rejected by 4 of 4 peer reviewers as fantasy.

**Decision (Yoav, 2026-05-17)**: proceed with Option A as written, council noted and overruled. The unaddressed concerns (forgery quantification, brother dependency conversation, cutover-first sequencing, PCI/privacy law) are flagged here so they get explicit attention during Phase 0 discovery — not because the rebuild is paused, but because skipping them would compound the very risks the council flagged.

**Open items to handle during Phase 0 (carried forward from council):**
- Measure 90-day Vollstart sales-vs-redemption gap. Even though the rebuild is going ahead, the number tells us how aggressive QR rollout needs to be.
- Have the explicit conversation with brother about 10-year maintenance dependency and what happens if Yoav becomes unavailable. Document brother's acceptance.
- Confirm payment processor / PCI scope: who handles cards today, what changes when we own the orchestration layer.
- Israeli Privacy Protection Law (2024 amendments) review — minors' PII handling, consent, breach notification, migration consent.
- Reframe customer area: punch-card holders need accounts, drop-in ticket buyers should be guest-checkout (phone + name, no password).
- Move the cutover importer + dual-read scanner work to **Phase 2** (alongside ticket model), not Phase 6. This is the one council point I am adopting structurally because the risk is real regardless of approach.

## Appendix A — Sources consulted (2026-05-17)

- Twilio Israel SMS pricing: $0.2575/msg outbound, $0.0075/msg inbound — https://www.twilio.com/en-us/sms/pricing/il
- BudgetSMS Israel: €0.25/msg standard — https://www.budgetsms.net/sms-gateway-pricing/il/israel/
- Plivo Israel: $0.18–$0.49/msg depending on carrier — https://www.plivo.com/sms/pricing/il/
- Neon Postgres pricing: $0 free (0.5 GB, 100 CU-hrs), $0.106/CU-hr Launch — https://neon.com/pricing
- Resend pricing: 3K free, $20/mo Pro for 50K — https://resend.com/pricing
- AccuPOS Israel website: no developer API/SDK mentioned, contact 077-2304880
- Vercel platform knowledge: Fluid Compute default, Node 24 LTS, 300s default timeout (knowledge-update 2026-02-27)
