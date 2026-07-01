# Punch-card booking — paid extra companion (מלווה נוסף) via WooCommerce

Date: 2026-07-02
Status: approved (Yoav said "go"), building now.

## Goal

A customer booking a round with their punch card in the personal area can add
one paid extra companion (₪12) to the booking. Payment happens in WooCommerce
(Yoav's constraint: all payments stay in WC). On cancellation the ₪12 is
auto-refunded alongside the punch-entry return.

## Decisions already made (chat, 2026-07-01/02)

- Payment stays in WooCommerce. No new payment integration.
- Companion is confirmed on **payment success** (webhook), not at click time.
- Auto-refund on cancel, same pipeline as WC round refunds.
- Max 1 extra companion per booking (existing API/schema cap).

## Capacity truth (important correction)

The super-brief (§ "נספרים רק כרטיסי ילד") and the shipped hold engine both
say **companions never consume round capacity** — only child tickets do, and
"הוספת מלווה נוסף מאוחר: תמיד אפשרי עד 1/ילד". So there is **no seat to
reserve** for the companion: no hold, no TTL, no sold-out edge case. Yoav's
earlier chat remark ("companion counts toward max people") contradicts the
brief; we follow the brief + engine. If Yanay ever wants companions to consume
capacity, that is a separate engine change (hold counting, availability,
dashboards) — out of scope here.

## Chosen flow (pay-after-booking)

1. Booking modal gets a checkbox: "מלווה נוסף +₪12" (price from settings)
   with the note that one companion is already included.
2. "אישור והזמנה" books with the punch entry exactly as today (instant,
   barcode minted). If the checkbox was on, the app then calls the new
   checkout endpoint, which creates a **pending WC order** (fee line, no
   product dependency) tagged with the booking id, and redirects the browser
   to WC's order-pay page.
3. Customer pays in WC (Meshulam). The existing order webhook (and the
   thank-you handoff, which calls the same processor) sees the paid order,
   finds `_memesh_companion_booking_id` in the order meta, and flips the
   booking's `additional_companions` 0 → 1. Idempotent per order.
4. Abandoned payment: nothing is lost — the booking stands with the included
   companion. The booking card shows "מלווה נוסף — ממתין לתשלום" with a
   retry button that reuses the same checkout endpoint (it returns the
   existing pending order's pay URL instead of creating a duplicate).
5. Cancel (>24h): punch entry returned (existing) + if the companion was paid,
   ₪12 auto-refunds through the existing `createOrderRefund` path. Refund
   failure keeps the booking (fail-closed, same as paid bookings).

## Alternatives rejected

- **Hold-then-pay (15-min hold)**: my original recommendation, built on the
  wrong assumption that companions consume capacity. They don't; a hold
  reserves nothing and adds a TTL/expiry surface for no benefit.
- **Un-drafting WC product 305 and linking line items**: requires Yanay-side
  config (product id in our env) and keeps a purchasable orphan product. A
  fee line on an API-created order needs zero WP-side setup.
- **Late-add for paid (WC-store) bookings**: out of scope v1. Their
  `wc_order_id` column already holds the ticket order, so companion-order
  bookkeeping would need a schema change. WC buyers choose the companion at
  purchase (checkbox on the product page, already live).

## Implementation

### packages/db (new `rounds-companion.ts`)

- `prepareCompanionCheckout(db, {bookingId, customerId})` — validates:
  booking exists, owned by customer, `source='punchcard'`,
  `status='confirmed'`, `additional_companions=0`. Returns booking + round
  display data (for the fee-line label) + current `wcOrderId` (retry case) +
  companion price from card settings.
- `recordCompanionOrder(db, {bookingId, wcOrderId})` — stamps the pending
  order id onto the booking (`wc_order_id`, free for punchcard rows).
- `confirmCompanionUpgrade(db, {bookingId, wcOrderId})` — transaction, row
  lock: cancelled/expired booking → error (money for a dead booking — logged
  for operator refund, same convention as mint_failed); replay with same
  order id → idempotent ok; else sets `additional_companions=1` +
  `wc_order_id`.
- `rounds-cancel.ts`: punchcard branch additionally refunds
  `additionalCompanions × roundAdditionalCompanionPriceIls` against
  `wcOrderId` when both are set, BEFORE releasing the seat; refund failure →
  `refund_failed` (booking kept). Unpaid pending order (companions=0) — no
  refund, order dies unpaid in WC.
- `listCustomerRoundBookings`: expose `companionPending`
  (`source='punchcard' && wcOrderId set && additionalCompanions=0`).

### apps/api

- `wc-rest-client.ts`: add `createOrder` (billing + fee_lines + meta_data →
  `{id, orderKey}`) and `getOrder` (`{id, status, orderKey}`). Pay URL built
  as `{site}/checkout/order-pay/{id}/?pay_for_order=true&key={orderKey}`
  where site = `WC_API_URL` minus `/wp-json/...`. No new env vars.
- `POST /rounds/companion/checkout` (requireCustomer, rate-limited): prepare →
  if existing order still pending/on-hold/failed → return its pay URL; if
  paid → `{alreadyPaid:true}`; if cancelled in WC → create a fresh order and
  re-stamp. If companion price ≤ 0 → confirm immediately (free), no order.
  503 when WC client not configured (same convention as refunds).
- `GET /rounds/availability`: add `companionPriceIls` to the response (one
  settings read) so the UI shows the real price, not a hardcoded ₪12.
- `wc-round-processor.ts`: order schema gains optional order-level
  `meta_data`; after minting holds, if `_memesh_companion_booking_id` is
  present on a paid order → `confirmCompanionUpgrade`. Runs on both delivery
  paths (webhook + thank-you handoff) like everything else.

### apps/customer

- Booking modal: companion checkbox card (same warm style), button label
  becomes "אישור, הזמנה ותשלום ₪{price}" when checked. After booking, on
  checkout-ok → `window.location.href = payUrl`; on checkout-fail → done
  screen notes the booking succeeded and payment can be retried from the
  booking card.
- Booking card ("הסבבים שלי"): "מלווה נוסף ✓" when confirmed;
  "מלווה נוסף — ממתין לתשלום" + "השלמת תשלום" retry button when pending.

## Added mid-build (Yoav 2026-07-02): round picker optional when no rounds exist

"If no rounds are set at all, don't make choosing mandatory; if there are
rounds for the chosen date, choosing is mandatory."

- New public `GET /rounds/enabled` → `{ enabled }` = any active round
  template exists (`anyActiveRounds` in packages/db). Rate-limited like
  availability.
- WP snippet: `memesh_rounds_enabled()` checks it server-side with a 5-minute
  transient cache. Disabled → no picker rendered, add-to-cart validation
  passes without a round, no hold call at checkout (ticket sells as a plain
  product). Enabled → current behavior.
- Interpretation: "rounds exist globally but none on the chosen date" stays
  BLOCKED (a rounds-run business with no rounds that day is closed that day).
  Only the no-rounds-at-all case relaxes the requirement.
- API outage while checking: snippet fails toward "enabled" (mandatory) —
  checkout's hold call would fail anyway, and it protects rounds integrity.
  Cached 1 minute on error vs 5 on success.

## Added mid-build #2 (Yoav 2026-07-02): master toggle, off dates, delete/duplicate

- `round_settings.rounds_enabled` (migration 0023) — master switch. Off →
  `/rounds/enabled` false, availability `roundsRequired:false`, tickets sell
  as plain products, punch modal shows "free play". Templates survive.
- `round_off_dates` table — whole-day off dates. Availability for an off
  date: `roundsRequired:false`, no bookable rounds. Admin manages them on
  the Rounds page (date chips). WP snippet checks per-date server-side
  (60s transient) in addition to the global check.
- `deleteRound` — hard delete ONLY when no booking ever touched the round
  (bookings are the audit trail); otherwise 409 has_bookings → deactivate.
  Waitlist entries + reminder-log rows go with it.
- `duplicateRound` — inactive copy with " (עותק)" suffix, straight into the
  edit form.
- Snippet now versioned at wordpress/memesh-rounds-snippet.php (secret
  placeholder — never commit the real one).
- NOT built yet (needs design alignment): per-date TIME-WINDOW rules and
  global recurring rules ("rounds only 14:00-16:00 on date X"). Open
  questions recorded in chat 2026-07-02: what happens outside the windows
  (free play vs closed), recurrence model, and how windows map to round
  templates that ARE time slots themselves.

## Security

- Checkout endpoint is customer-gated + owner-checked in the DB helper; a
  customer can only attach a companion order to their own booking.
- Order → booking linkage travels as order meta written by OUR server via the
  authenticated REST API; the webhook still verifies the WC HMAC before the
  processor runs. A forged webhook can't pass the signature; a paid order
  with meta pointing at someone else's booking would require WC admin access
  (same trust level as refunds).
- Refund stays fail-closed: no seat release without confirmed refund.
- No new secrets; reuses `WC_API_*` and `WC_WEBHOOK_SECRET`.

## Observability

- API: `[rounds companion checkout]` (created/reused/alreadyPaid/free, with
  bookingId + wcOrderId), `[wc companion]` in the processor
  (confirmed/replayed/booking_cancelled), `[rounds cancel]` gains
  companion-refund fields.
- UI: `console.info('[customer companion] …', {bookingId, wcOrderId})` on
  checkout start / redirect / retry / failure.

## Settings audit

- Price (`roundAdditionalCompanionPriceIls`) and per-child cap are already
  admin settings; the availability endpoint now surfaces the price so UI
  follows the setting. Intentionally NOT adding an on/off toggle for the
  upsell — one more knob with no demonstrated need; flag to Yanay, add later
  if asked.

## Testing

- db unit (PGlite): rounds-companion (validate/record/confirm/idempotency/
  cancelled-booking), cancel-with-companion-refund (amount, fail-closed,
  pending-unpaid no-refund), listCustomerRoundBookings pending flag.
- api unit: wc-rest-client createOrder/getOrder (mock fetch), processor
  companion branch (paid/unpaid/bad meta/replay), route gates (401/400/
  403/404/409/503).
- SPA: typecheck only (no test framework in apps/customer — existing
  convention; UI logic kept thin).

## Deploy

- One PR from `feat/punch-companion-upsell` into `main`; merge deploys prod
  via Vercel as usual. No env or WP changes required. Rollback = revert.

## Out of scope / follow-ups

- Auto-refund when a paid companion lands on a cancelled booking (operator
  log for now, same as mint_failed refunds TODO).
- Late-add companion for paid (WC-store) bookings.
- SMS/notification on companion confirmation.
- WP thank-you redirect back to the personal area for companion orders
  (works if Yanay's existing handoff covers all orders; harmless if not —
  the async webhook confirms within seconds).
