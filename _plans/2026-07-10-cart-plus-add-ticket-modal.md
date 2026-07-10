# Cart/checkout "+" opens the round picker (add-ticket modal)

Date: 2026-07-10
Source: Yanay's WhatsApp feedback, 2026-07-09 21:55-21:57. He first asked to
remove the +/- quantity steppers from the cart and payment page, then reversed:
keep them ("it can bring more sales"), but pressing "+" must force a date+round
choice — "to add another ticket you must pick a date" — defaulting to the
original line's date.

## Goals

- "+" on a ticket line in the cart or on the checkout page opens a popup with
  the standard day-strip/calendar round picker, preselected to that line's
  date, and adds the new ticket as its own cart line.
- "−" removes the line (its auto-added companion line follows, existing hook).
- A line can never actually reach quantity 2, no matter which UI touches it.
- One flow, zero instructions needed: the shopper taps +, sees the familiar
  picker with the same day already chosen, taps a round, taps add.

## Approach

All inside `wordpress/memesh-rounds-snippet.php` (the WP side owns cart and
checkout rendering; nothing changes in the API or apps):

1. `woocommerce_cart_item_quantity` now returns memesh-owned stepper markup for
   entry-ticket lines: `−` (WC remove URL) / `1` / `+` (data-product-id +
   data-date). Companion lines stay a plain "1" (auto-managed). Rounds-off mode
   stays a plain "1" (no picker to open).
2. New `woocommerce_after_cart_item_quantity_update` clamp: any quantity above
   1 on a ticket/companion line snaps back to 1 with a notice. Defense in depth
   against theme/plugin steppers that bypass the filter; without it a bumped
   line only fails later, at order creation, with a scarier error.
3. New hidden modal rendered on cart/checkout (`wp_footer`) when rounds are on
   and a ticket line exists. Hosts the same `memesh_render_round_picker()` +
   AJAX form (`wc_ajax_memesh_add_to_cart`) the price-list popups use, so all
   validation/companion/upsell hooks fire unchanged.
4. Behavior script additions: `root.memeshSelectDate(iso)` (jump the picker to
   a date, fetching its month when beyond the 31-day strip; falls back to today
   when out of window or fully in the past), `data-default-date` for
   modal-opened-before-strip-loaded races, capture-phase click wiring for
   `.memesh-qty-plus` and modal close, Escape-to-close, and
   `data-reload-on-add`: a successful modal add reloads the page — the new line
   and total ARE the confirmation.

## Alternatives rejected

- Remove +/- entirely (Yanay's first message): reversed by Yanay himself.
- Intercept the theme's own steppers in JS: markup is theme/plugin-specific and
  unknowable; owning the markup via the WC filter is deterministic.
- AJAX-refresh fragments instead of reloading after add: Elementor cart/
  checkout widgets refresh inconsistently; a reload is predictable and shows
  the authoritative server-rendered state. Tradeoff: billing fields typed
  BEFORE adding the ticket may clear on checkout reload; acceptable because
  adding tickets naturally happens before filling details.

## Security

- No new endpoints; the modal reuses the nonce-protected AJAX add-to-cart.
- All PHP output escaped (`esc_url`/`esc_attr`); JS builds DOM via
  createElement, API data never concatenated into HTML (existing pattern).
- The quantity clamp + the existing order-line quantity guard keep one seat ==
  one hold == one charge, regardless of client behavior.

## Observability

- `[memesh qty]` console namespace: modal opened (product, default date),
  modal closed, added-and-reloading.
- `[memesh picker]` gains default-date logs (beyond-strip month fetch, fetch
  failure).
- Server: `error_log('[memesh cart] quantity N ... clamped back to 1 ...')`.

## Settings

No new admin settings. The stepper exists wherever rounds are on; with rounds
off, lines are plain quantity-1 products (sold_individually still applies).
Not exposing a toggle for the stepper itself: Yanay explicitly chose this
behavior; a knob would just re-open the door to the unsafe bare quantity bump.

## Testing

The snippet is PHP+inline-JS pasted into WP Code Snippets; the repo has no PHP
test framework and the monorepo suites (node --test) cannot execute it. This is
declared untestable-in-repo per the standing testing rule; verification is the
manual QA checklist below on the live site (staging equivalent does not exist
for WP). API behavior it leans on (validation, companion auto-add, hold-per-
line idempotency) is already covered by apps/api tests.

Manual QA after pasting into WP:
1. Cart page: ticket line shows − 1 +; companion line shows plain 1.
2. "+" opens the modal, the line's date is preselected, its rounds listed.
3. Add on same day → new line, correct round, totals updated after reload.
4. Change date in modal (strip + calendar) → line lands with the chosen date.
5. Line with a date beyond 31 days → modal preselects it (month fetch).
6. "−" removes the line AND its companion line.
7. Checkout page: same stepper on the items list; add + reload returns to
   checkout with the new line.
8. Escape / backdrop / × close the modal; reopening keeps working.
9. Bump quantity via any leftover foreign stepper → snaps to 1 with the notice.
10. Rounds switched off globally → plain "1", no modal markup in the page.

## Revision 2 (2026-07-11, after Yanay's video)

Yanay's 2026-07-10 23:45 video (first live test) showed three gaps:
the checkout items table draws ITS OWN steppers and ignores
`woocommerce_cart_item_quantity` (ticket "+" disabled via sold_individually,
companion "+" clickable), the modal opened with no product/date attached
(landed on a closed "today"), and a day with a single round still demanded a
tap — the add button sat disabled on "בחרו סבב כדי להמשיך", which read as
"doesn't let me add". Fixes, all snippet-side:

1. `woocommerce_quantity_input_args` pins min/max to 1 for tickets AND the
   companion, disabling native steppers everywhere. sold_individually was not
   usable for the companion — WC would refuse the second companion line when
   two children each bring an extra adult.
2. A snippet-owned "הוספת כרטיס לילד/ה נוסף/ת" button on classic WC hooks
   (`woocommerce_after_cart_table`, `woocommerce_review_order_before_payment`)
   opens the modal with the first ticket line's product + date — independent
   of theme markup.
3. The modal root carries server-rendered fallback product/date; any opener
   without its own data inherits them instead of submitting empty.
4. A single mandatory round auto-selects in the picker (all picker surfaces:
   product page, price-list popup, add-ticket modal). Real choices (2+
   rounds, optional free-play days) still require the tap.

## Deploy

- Branch `fix/wp-snippet-cart-plus-modal` → PR into `main`. Repo merge does NOT
  deploy anything (the snippet runs from WP's DB).
- Actual rollout: regenerate the Yanay handoff txt (gitignored, real secret
  injected) and have him paste the full snippet into WP Admin → Snippets →
  "Memesh Rounds". This SUPERSEDES the 2026-07-07 paste; his 2026-07-09
  screenshots show stepper behavior that predates even that version, so the
  live snippet is stale — pasting this one closes both gaps.
- Rollback: re-paste the previous handoff txt.
