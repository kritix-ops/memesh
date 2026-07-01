# Rounds Phase 1 — full build runway

**Date:** 2026-07-01
**Author:** Claude (Opus 4.8) for Yoav (Flexelent)
**Scope:** everything in `memesh-rounds-super-brief.md` §17 (Phase 1).
**Companion docs:** `2026-07-01-rounds-purchase-and-management-flow.md` (deep
technical decisions for the spine, council-reviewed) · `2026-07-01-super-brief-gap-audit.md`
(what's already built vs the spec).

## How this is sequenced

The brief is one product but ~16 shippable PRs. They're grouped into waves. Each
PR ships + tests independently. Waves 1–2 are the spine (a customer can buy and
manage a round); waves 3–6 fill out the rest of Phase 1. Build order inside a
wave is mostly strict; some items are parallelizable (noted).

Config approach: a new `round_settings` store (singleton, same pattern as
`dashboard_settings`) holds the §15 operational params. It's introduced lean in
PR2 (only what the spine reads: hold TTL, cancellation window, claim window) and
extended as later PRs need params, with the full admin UI consolidated in PR15.
Nothing is hardcoded that the brief says is configurable.

## Principles (carried from the spine plan)

- The booking ledger is the single source of truth for a seat; WooCommerce is a
  second ledger reconciled via idempotent mint + webhook dedupe. Money-safety is
  the axis: never release a seat on unconfirmed money.
- Owner-authz on every customer action; server-side window enforcement; opaque ids.
- Barcode HMAC signs `booking_id + version`; swap bumps version; scanner
  validates current version.
- Times computed in UTC against Asia/Jerusalem; hold TTL + 24h cutoff DST-safe.
- Concurrency (the hold race) gets a real-Postgres test; everything else stays on
  the PGlite fixture.

## Wave 1 — Spine: buy a round, see it

- **PR1 — Availability (read-only).** `GET /rounds/availability?date=` → per
  round_instance: label, times, capacity, available (child-only), isClosed.
  Public + rate-limited (the WP picker needs it pre-login). Reuses the dashboard
  occupancy query. **START HERE — zero writes, zero risk.**
- **PR2 — Hold engine + `round_settings`.** `POST /rounds/hold` (SELECT FOR
  UPDATE, race-safe insert, TTL), `POST /rounds/hold/release`, expiry sweeper
  cron. `round_settings` store with hold_ttl_minutes + cancellation/claim windows.
  Real-Postgres concurrency test.
- **PR3 — Mint + dev-pay stub.** `POST /rounds/mint` (held→confirmed, HMAC
  barcode+version, idempotent on wc_order_id, hold-expiry recovery) + a dev
  "pay now" that calls mint directly. Buy→booking works without WordPress.
- **PR4 — Customer round-picker (list) + personal-area view.** Minimal list
  picker (calls availability→hold), and the personal area shows confirmed round
  bookings + barcode. (Calendar/tiles views deferred to PR16.)
- **PR5 — WooCommerce wiring.** Round products (1001/1002/1003), checkout
  handoff (hold_id + round meta as order meta), webhook dedupe → mint. Replaces
  the dev stub. *Parallelizable:* `createOrderRefund` in wc-rest-client + WC
  product setup (Yanay). Needs Yanay: products, checkout snippet, webhook, API
  keys, and confirmation the gateway refunds via API.

## Wave 2 — Manage the booking (the owner's ask)

- **PR6 — Swap ("change my time").** `POST /rounds/swap` atomic move until
  original start, bump barcode version + re-issue, trigger waitlist on vacated
  instance. Customer UI.
- **PR7 — Cancel + refund ("get my money back").** `POST /rounds/cancel`, 24h
  server-side gate, refund saga (intent → WC refund → release on confirmed →
  waitlist → reconcile job), punch return when source=punchcard. Front-desk
  override. Customer UI.

## Wave 3 — Entry + staff shift operations

- **PR8 — Staff scan → used + search.** `POST /staff/rounds/punch` (HMAC verify
  current version → used, one-time) + `POST /staff/rounds/lookup` (name + round).
- **PR9 — Staff walk-in + in-place swap + companion controls.** `POST
  /staff/rounds/walkin`, in-place swap, companion-availability display,
  id-check-policy display.

## Wave 4 — Waitlist automation

- **PR10 — Waitlist.** `POST /waitlist/join` + `POST /waitlist/claim`; FIFO
  promotion on any release; quiet hours + claim window from settings.

## Wave 5 — Notifications + gift

- **PR11 — Stay reminders.** Batch on round end_time − offsets, skip last round,
  via existing SMS/email infra. Scheduled job.
- **PR12 — Gift purchase for rounds.** Extend the gift meta → round mint →
  recipient account link + notification (reuses the card gift plumbing).

## Wave 6 — Conversion + full config surface

- **PR13 — Upsell (§12).** Per-ticket comparison + group-buy layer + 5
  placements + settings.
- **PR14 — Terms + socks gate (§14).** Blocking checkout checkbox, editable
  terms text, sock_sales POS toggle.
- **PR15 — Full admin surface.** All §15 settings + UI; per-date capacity
  override/closure; bookings management (view/filter/cancel/override); round
  pricing UI; barcode regen; occupancy/revenue/no-show reports.
- **PR16 — Selection-view widget (§13).** Calendar + tiles views for the WP
  picker (list already shipped in PR4).

## What Yanay does (WooCommerce/WordPress), and when

At **PR5**, not before: create the 3 round products (stock management OFF),
add the checkout snippet (spec provided), point the order-paid webhook at the
rounds mint, provide WC REST API keys with refund permission. Early check he can
do anytime: confirm the payment gateway (Meshulam/Grow) supports refunds via API
— the only external unknown that could change the cancel/refund design.

## Deferred beyond Phase 1

The generic multi-vertical inventory engine / event bus (build concrete
primitives with clean seams instead); advanced reporting; anything §17 marks as
Phase 2.

## Status

Building now, in order. PR1 first.
