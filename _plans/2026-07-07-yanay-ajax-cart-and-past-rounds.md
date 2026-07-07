# Yanay 2026-07-07 — silent add-to-cart + block past rounds

Two bugs Yanay reported on the rounds booking flow (WhatsApp, 22:46 / 22:48).

## Goals

1. **Add-to-cart must not redirect to the WooCommerce product page.** From the
   price-list popup, "הוספה לסל" should add the ticket to the cart in place, show
   a confirmation, and never navigate away. It must also never let a second
   ticket be added without a round chosen (בלי שיבוץ) — the redirect to the
   product page is exactly the hole that let that happen (the native product-page
   button is enabled by default).
2. **A round whose time has already passed today must not be bookable.** Past
   *dates* are already blocked (the strip starts at venue-today; the calendar
   disables earlier cells). The gap is *today's* rounds that have already ended —
   they still show and can be added.

## Decisions (confirmed with Yoav 2026-07-07)

- **Past-round cutoff = when the round has ENDED** (endTime passed in venue time).
  A round in progress is still bookable; matches Yanay's wording "hours that
  passed" and preserves same-window walk-in sales.
- **Post-add UX = confirmation inside the popup** with two buttons: מעבר לתשלום
  (checkout) and הוספת ילד/ה נוסף/ת (reset the picker for another child). No
  navigation, theme-independent, fits the multi-child order flow.

## Approach

### Server (single source of truth for "past")
The past-time rule lives in the API, not the PHP snippet — the browser clock
can't be trusted for venue time (host is UTC; venue is Asia/Jerusalem), and the
same availability endpoints feed the WP picker, the customer dashboard strip, and
the staff jumper. Fixing it server-side fixes all three and is unit-testable.

- `round-time.ts`: add `isRoundEnded(dateIso, endTimeHhmm, now)`, reusing the
  existing venue wall-time math (`roundStartWallMs` / `venueWallMs`).
- `rounds-availability-range.ts`: for the **venue-today row only**, drop rounds
  that have ended. `closed`/`roundsRequired` are computed from the pre-filter
  rows so a today with every round passed reads as "no rounds available today"
  (dot: none), not "closed".
- `rounds.ts` `roundAvailabilityForDate`: same today-only filter, so the swap
  round list also stops offering passed rounds. Display-only path — never used
  for hold/booking gating, so no capacity impact.
- Filter is keyed on `date === venueTodayIso(now)`, so future days and the
  existing fixed-`NOW` tests (ranges dated 2026-07-10) are untouched.

### PHP snippet — AJAX add-to-cart for the price-list popup only
The product-page purchase path is unchanged. Only the `[memesh_round_picker]`
shortcode form (the Elementor popup) becomes AJAX.

- New `wc_ajax_memesh_add_to_cart` endpoint (front controller, works for guests,
  cart session loaded). Nonce-guarded. It calls `WC()->cart->add_to_cart()` with
  the memesh_* fields present in `$_POST`, so the existing
  `woocommerce_add_to_cart_validation` / `woocommerce_add_cart_item_data` /
  `woocommerce_add_to_cart` (companion + notices) hooks all fire exactly as they
  do for the current full-page POST. Returns JSON: `{ ok, count, round }` or the
  validation error text pulled from `wc_get_notices('error')`.
- Shortcode markup gains `data-add-url` / `data-nonce` / `data-cart-url` /
  `data-checkout-url` on the form and a hidden confirmation block.
- Footer JS: intercept the shortcode form's submit, POST via fetch, on success
  swap the picker for the confirmation, wire "add another" to reset the picker
  (clear round selection, keep the day) and "checkout" to the checkout URL. Form
  keeps its product-page `action` as a no-JS fallback.
- Notices cleared after reading so the queued success/upsell notice can't leak
  onto the next page.

## Security (rule 13)
- Nonce on the AJAX endpoint (CSRF). Anyone may add to cart, so no capability
  gate. Shared secret and hold auth are unchanged.
- All fields sanitized by the existing hooks; JSON response carries no internals.

## Observability (rule 14)
- JS: `console.info('[memesh cart] ajax add', {...})`, success/error branches.
- PHP endpoint: `error_log('[memesh cart] ...')` on validation reject / cart fail.
- API: the availability routes already log; the today-filter is covered by the
  existing `[rounds availability-range]` line.

## Testing (rule 18)
- `round-time.test.ts`: `isRoundEnded` before/after venue end time.
- `rounds-availability-range.test.ts`: today row drops an ended round, keeps a
  not-yet-ended one; a future day is unaffected.
- `rounds-crud.test.ts`: `roundAvailabilityForDate` drops today's ended round.
- PHP snippet has no test harness (repo tests the Node API) — the AJAX flow is
  manually verified on staging. Flagged, not silently skipped.

## Deploy (rule 19)
- API change ships through the normal PR → main pipeline (main is
  production-tracking; no manual promotion).
- The snippet is pasted into WP by hand from the regenerated
  `2026-07-07-yanay-snippet.txt` handoff (gitignored, holds the real secret).
  The API's `/rounds/availability-range` change must be deployed **before** the
  new snippet, but the snippet also works against the old API (it just wouldn't
  hide past rounds yet), so ordering is not hard-blocking.

## Out of scope
- The product-page (non-shortcode) purchase path keeps its normal WC behavior.
- Past *dates* (already handled). Fully-past days in `availability` are left as
  they are — the pickers never request them.
