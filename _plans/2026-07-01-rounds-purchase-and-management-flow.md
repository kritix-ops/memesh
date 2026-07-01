# Rounds purchase + management flow — implementation plan

**Date:** 2026-07-01
**Author:** Claude (Opus 4.8) for Yoav (Flexelent)
**Status:** DRAFT for review. No code until approved.
**Pressure-tested by the LLM council** (verdict folded into the principles + open questions below).

## Goal

Let a customer buy a round online, see it in their personal area, and manage it
(change the time, or cancel with an automatic WooCommerce refund). The owner's
ask is the *tail* (swap/cancel/refund); the foundation that produces a real
booking is unbuilt. This plan builds the whole flow in the correct order.

## What exists / what doesn't

- **Built:** rounds + round_instances tables, admin defines rounds + materializes
  instances, dashboard/staff read occupancy. The punch-card WC mint
  (`wc-handoff`) + webhook safety net — the proven pattern to copy.
- **Not built:** availability endpoint, holds, anything that creates a booking,
  the rounds WC products + checkout handoff, the mint extension for rounds, the
  customer personal-area booking view, swap, cancel, and **any WooCommerce
  refund capability at all**.

## Architecture principles (from the council)

1. **The booking ledger is the single source of truth for a seat.** WooCommerce
   is a *second ledger* we do not control and cannot lock. The whole design is
   about keeping the two honest, not about one clever row lock.
2. **Oversell is a count invariant, not a lock.** `available = capacity −
   (confirmed + used + active holds)`, child tickets only. A `SELECT ... FOR
   UPDATE` on the `round_instance` serializes the *check-and-insert* for a hold
   (correct and necessary). It does **not** cover the hold that expires during
   payment — that is handled at mint (re-check) + the sweeper + WC reconciliation.
3. **Never release a seat on unconfirmed money.** Cancel is a saga: record cancel
   intent → attempt WC refund (idempotent) → release the seat + trigger waitlist
   **only on confirmed refund** → a reconciliation job settles stragglers →
   manual override when the refund API is down. A Woo outage must never free a
   paid seat.
4. **Concrete primitives, not a speculative engine.** Build a small, clean
   `releaseSeat(bookingId, reason)` and `moveBooking(bookingId, targetInstanceId)`
   service used by swap/cancel/waitlist. Keep the seams. Do **not** build the
   generic multi-vertical "inventory engine" / event bus now (council flagged
   this as premature abstraction over an unbuilt foundation).
5. **Ship value before touching WordPress.** A dev "pay now" stub calls mint
   directly, so buy → see-in-personal-area works end to end before the WC wiring.

## Locked technical decisions (resolve before coding each step)

- **Barcode on swap.** HMAC signs `booking_id + version` (a monotonic int on the
  booking). Swap bumps the version and re-issues; the scanner validates the
  *current* version server-side. An old screenshotted QR from before a swap is
  rejected. (Without this, a swapped-away slot's QR still opens the door.)
- **Hold creation (race-safe).** Transaction: `SELECT ... FOR UPDATE` the
  round_instance, recount taken (confirmed + used + active holds), insert
  `held` + `hold_expires_at = now + TTL` only if `taken + requested ≤ capacity`.
- **Hold expiry.** Lazy (availability ignores expired holds) + a sweeper cron
  (`held` → `expired` when `hold_expires_at ≤ now`), which also triggers waitlist.
- **Mint (WC → booking).** Clone the punch-card mint. Idempotent on
  `wc_order_id`. Re-check availability: hold valid → confirm; hold expired but
  room → confirm anyway; no room → `payment_received_no_slot` + alert + refund.
- **WC webhook idempotency + ordering.** Webhooks arrive duplicated, out of
  order, and retried; payment-complete can land before/after/twice around hold
  expiry. Durable dedupe keyed on `wc_order_id` (+ event id); mint is the single
  idempotent path both the thank-you redirect and the webhook call into.
- **Refund saga.** Idempotency key per cancel so a retried cancel never
  double-refunds. New `createOrderRefund` in `wc-rest-client` (does not exist
  today). Full refund only for v1.
- **Authz / tenancy.** Every customer booking action is gated to the owner
  (session `customer_id === booking.customer_id`). Opaque ids, no enumeration.
  The 24h window is enforced **server-side**, never trusted from the client.
- **Time.** Store/compare in one explicit tz (Asia/Jerusalem). Compute the hold
  TTL and the "24h before start" cutoff in UTC so DST and server-vs-local never
  drift the cutoff.

## Build sequence (PR by PR)

Strictly ordered unless noted. Each PR ships + tests independently.

1. **Availability (read-only).** `GET /rounds/availability?date=` →
   bookable child slots per round_instance, reusing the dashboard's occupancy
   query. Zero writes, zero risk. Unblocks the customer round-picker UI and
   forces the canonical availability definition. **First PR.**
2. **Hold + sweeper.** `POST /rounds/hold` (race-safe insert), `POST
   /rounds/hold/release`, and the expiry sweeper cron. Real-Postgres concurrency
   test for the oversell race (see Testing).
3. **Mint + dev-pay stub.** `POST /rounds/mint` (clone punch-card mint,
   idempotent, hold-expiry recovery) + a dev "pay now" that calls it directly.
   Now a booking exists end to end without WordPress.
4. **Personal area — view.** Customer sees confirmed round bookings + barcode
   next to punch cards. Authz to owner.
5. **WooCommerce wiring.** Round products (1001/1002/1003), checkout handoff
   (hold_id + round meta ride the order), webhook dedupe. Replaces the dev stub.
   *Parallelizable with 2–4:* the `wc-rest-client` refund method + WC product
   setup.
6. **Swap.** `POST /rounds/swap` — atomic move to another available instance
   (until original start), bump barcode version + re-issue, trigger waitlist on
   the vacated instance. Customer UI: "change my time".
7. **Cancel + refund saga.** `POST /rounds/cancel` — 24h server-side gate,
   record intent → WC refund → release on confirmed → waitlist → reconcile job.
   Customer UI: "get my money back". Front-desk override path.
8. **Waitlist promotion + reminders + door-fallback** (follow-ups): notify on
   release with a timed claim link; reminders; staff lookup when a barcode fails.

## Security

- Owner-gated customer actions; server-side 24h enforcement; opaque booking ids.
- Refund idempotency keys → no double refund; refund never issued without a
  matching cancel intent.
- Rate-limit `POST /rounds/hold` (mass holds = capacity-exhaustion DoS).
- Children's data + waitlist contact info: minimize, and confirm consent/retention
  obligations before storing (open question below).
- Staff scan + refund actions gated by staff role; audit-log refunds + cancels.

## Testing

- **Real Postgres (not PGlite) for the hold race.** Single-connection PGlite
  cannot exercise `SELECT FOR UPDATE` contention, so the oversell guard is
  untested by construction there. Add a concurrency test on real Postgres
  (testcontainers or a CI service) that fires N parallel holds at a
  capacity-1 instance and asserts exactly one wins. Everything else stays on the
  existing PGlite fixture.
- Idempotency tests: double mint on one `wc_order_id`, replayed webhook,
  retried cancel → single effect each.
- Standard route tests for auth/role gates + validation.

## UX requirements (from the council's "real parent" lens)

- **Loud hold timer.** Show the 15-min countdown; on expiry say plainly "no money
  was taken."
- **One clear confirmation** after payment (barcode, date, time, child count) +
  the same by email; survive double-tap / closed tab / back button.
- **Plain language:** "change my time" / "get my money back", not "swap" /
  "cancel".
- **Refund timing:** tell them how many days the refund takes to appear.
- **Waitlist clarity:** how long they have to grab a freed spot, what happens if
  they miss the notification.
- **Door fallback:** what staff do when a barcode fails with a kid in line.

## Deferred / out of scope (leave seams, do not build now)

- The generic multi-vertical inventory engine + domain-event bus (Expansionist's
  idea — good, but premature until the ledger is proven).
- Waitlist-as-resale automation beyond the basic claim flow; reminders;
  attendance analytics; peak pricing.

## Open product questions (need Yanay/Yoav before steps 7–8)

1. **Sick-child exception.** The 24h cancel cutoff punishes the single most
   common cancellation (kid gets a fever at hour 23). What may the front desk do
   — manual refund override, credit, forced swap? This shapes the cancel UI + the
   override path.
2. **Waitlist claim window** length + notification channel (SMS/email), and the
   "you missed it" behavior.
3. **Partial refunds / fees** — full refund only for v1, or a cancellation fee?
4. **Children's-data retention/consent** — what we must show/store to be
   compliant for minors' booking data.
