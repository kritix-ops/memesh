# Heal charged-but-unpaid WC orders (PayPlus callback completion failures)

Date: 2026-08-08
Status: approved (urgent customer-impact bug reported by Yanay), building in
worktree `Memesh-fix-paid-order-cancelled`, branch `fix/paid-order-cancelled`.

## The incident

Order 6051 (07/08 15:34): customer paid ₪55 through PayPlus at 15:35:24 (charge
approved, voucher issued), but WooCommerce kept the order `pending`. At 16:41
WC's unpaid-order time limit auto-cancelled it and emailed the customer a
cancellation. She was charged, got no confirmation, no seat in the round, and
nothing in her personal area.

Verified from the order itself: the PayPlus plugin's callback DID arrive and
wrote its full meta (`payplus_status=approved`, `payplus_status_code=000`,
`payplus_type=Charge`, `payplus_transaction_uid`, voucher number) — but the
plugin failed to call payment-complete, so `date_paid` stayed null and the
status stayed `pending`. This is a plugin-side completion failure, intermittent,
and invisible to every safety net we have:

- The live order webhook and the per-minute rounds-reconcile cron (PR #124) only
  act on `processing`/`completed` orders. A charged order stuck in `pending`
  (and later `cancelled`) never enters the paid set.
- WC then cancels it, which reads to the customer as "the business cancelled on
  me" while their money is gone.

Sweep of cancelled orders since PayPlus go-live (17/07 → 08/08): **16 orders
charged and auto-cancelled, ₪1,910 total, zero refunds recorded.** 15 round
orders + 1 punch-card order (5169, ₪550) — both domains are exposed.

## Root-cause boundary

The true bug lives in the PayPlus WooCommerce plugin (not in this repo). We
cannot patch it here, and it has already failed ~16 times in 3 weeks. So the fix
is a backstop on our side that makes the failure self-healing, exactly like the
rounds-reconcile cron was for the webhook-secret incident.

Key insight that makes this cheap: **no PayPlus API access is needed.** The
plugin's callback meta on the WC order is itself proof of the charge. An order
with an approved Charge in its meta and `date_paid == null` is definitionally a
victim.

## Fix

New module `apps/api/src/lib/wc-paid-cancel-heal.ts` + wiring into the existing
per-minute `/cron/rounds-reconcile` route (runs BEFORE the round reconcile pass,
so a healed order is minted on the same tick):

1. Fetch recent `pending` and `cancelled` orders (same lookback env,
   `WC_RECONCILE_LOOKBACK_HOURS`, default 48h).
2. Detect victims: `date_paid == null` AND meta shows
   `payplus_status=approved` + `payplus_status_code=000` + `payplus_type=Charge`
   + non-empty `payplus_transaction_uid` AND no WC-recorded refunds.
3. Grace window for `pending`: skip orders modified in the last 5 minutes
   (per `date_modified_gmt` — the API host is UTC, never parse WC's local
   dates) so we never race the plugin's own completion. `cancelled` is terminal
   — healed immediately.
4. Heal: `PUT /orders/{id}` with `{ status: 'processing', set_paid: true,
   transaction_id }`. Effects, all through existing paths (SSOT — no new mint or
   email logic):
   - WC emails the customer the normal "order processing" confirmation (the
     email they never got).
   - WC fires its own `order.updated` webhook → our live webhook mints
     rounds/cards as with any paid order.
   - Belt-and-braces: the round reconcile pass that runs right after the heal in
     the same cron tick lists `processing` orders fresh and mints.
5. `mintBooking` already handles the expired-hold case: it re-checks capacity
   and mints if a seat remains; if the round genuinely filled up it returns
   `sold_out_after_payment` → the existing `orphaned_paid_seats` WARN alarm →
   operator refund. Fail-safe in both directions.

Per-order try/catch: one WC 500 must not strand the other victims; failures are
counted, logged, and retried next minute.

## Alternatives rejected

- **Reconcile against the PayPlus transactions API.** The right shape in theory,
  but needs PayPlus API credentials we don't have in any env, a new secret to
  provision, and a new external dependency — while the WC meta already proves
  the charge. More moving parts, zero extra recall on every observed victim.
- **WP-side guard (snippet on `woocommerce_cancel_unpaid_order`).** Would stop
  the cancellation email, but relies on undocumented plugin internals from PHP,
  is deployed by hand outside git/CI, and still would not mint the booking if
  the plugin fails to complete payment. The API-side heal covers both.
- **Extend the WC hold-stock timeout.** Only delays the damage; the order still
  never becomes paid and the seat never mints.

## Historical remediation (operational, not code)

The steady-state cron (48h lookback) auto-heals 6051 and 6060 on first
production run. The other 14 victims are older; their rounds have passed, so
re-minting a seat is meaningless — they need refunds/goodwill via the PayPlus
dashboard. Victim list (names + amounts + transaction uids) delivered to Yoav in
chat; deliberately NOT committed to the repo (customer PII).

## Security

- No new secrets, no new routes, no new inputs: runs inside the existing
  CRON_SECRET-gated route.
- Writes to WC are least-privilege in effect: only `pending/cancelled` orders
  carrying a provably approved charge can transition, only to `processing`.
- Refund-recorded orders are skipped (never resurrect an order that was already
  made whole).
- No PII in logs: order ids, amounts, and counts only.

## Observability

- `[cron rounds-reconcile] healed_charged_orders` at WARN whenever healed > 0
  (an operator should know money was rescued), with order ids + totals.
- Heal failures at ERROR with order id + error; scan/skip counts on the routine
  `done` INFO line alongside the existing reconcile fields.
- Cron response body includes the heal result for manual runs.

## Settings

Nothing new exposed. Lookback reuses `WC_RECONCILE_LOOKBACK_HOURS`; the 5-minute
pending grace is a code constant (an operator knob here would only invite
misconfiguring the race guard). Intentional.

## Testing

- `wc-paid-cancel-heal.test.ts` (pure unit tests, fake deps, no DB): heals a
  charged cancelled order; heals a stale charged pending order; grace-skips a
  fresh pending order; skips paid / refunded / unapproved / non-Charge /
  missing-uid orders; per-order failure isolation; empty window; result counts.
- Route-level: existing cron auth tests keep covering the gate (unchanged).
- Full `apps/api` suite must stay green.

## Deploy

- prod = `main`; the API redeploys on merge to `main`.
- This branch → PR into `main`; NOT touching `main` directly, NOT touching
  `feat/wave2-staff-content`, no env var changes (reuses existing WC + CRON
  secrets).
- Rollback: revert the PR — the heal is additive inside an existing cron.
