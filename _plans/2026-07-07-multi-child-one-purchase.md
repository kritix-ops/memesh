# Multi-child in one purchase + close the cart quantity hole

Date: 2026-07-07
Status: implemented on branch `feat/multi-child-booking` (off `main`), tests
green, NOT committed/pushed — awaiting Yoav's review before commit/PR.

## Problem

Yanay, two asks on the WooCommerce entry-ticket flow:

1. A parent with several children cannot book them all in one purchase. Each
   child might go on a **different** day/round. Today the snippet's
   add-to-cart validation blocks a second ticket of the same product
   (`if ($existing === (int) $product_id) return false;`) and pushes the
   punch-card upsell, so two same-age kids in one order is impossible.
2. A "weakness": in the cart the quantity can be bumped (the `+`), and the
   extra unit carries no date/round — it would be paid for with no reserved
   seat. Yanay's fix: remove the `+` in the cart, or at least force a date.

## Key facts (verified)

- The seat hold fires in `woocommerce_checkout_create_order_line_item` — at
  **checkout, once per cart line, all in one request**, NOT at add-to-cart.
  So multiple children = multiple lines = one existing hold call each. No API
  or DB change is needed. There is no "staggered TTL across a long add
  session" problem: all holds are born together at checkout, and a full round
  throws there **before** the order is created (no charge).
- WooCommerce keys a cart line by a hash of its cart-item-data
  (`generate_cart_id`). Two picks with different data are different lines; two
  identical picks merge into qty 2. Bundles/Composite add a unique identifier
  field for exactly this reason (confirmed via WooCommerce docs).
- `sold_individually`'s "you cannot add another" check matches the full
  cart-id (product + data), not the bare product id (confirmed). With a unique
  token per pick it never fires, while still forcing qty 1 per line.
- `woocommerce_cart_item_quantity` is the documented way to render a cart
  line's quantity as fixed text — Bundles uses it to lock bundled quantities.

## CRITICAL correctness finding (QA, 2026-07-07)

The WC hold path passes `reuseActiveHold: true` and `createHold` reuse matches
on **customer + round + ticketType**. That was safe under the old "one line per
ticket product per cart" assumption. Multi-child breaks it: **two siblings on
the same round** in one cart → the second line's `/rounds/hold/wc` call reuses
the first line's hold → one seat held, two children paid = **oversell**. Fires
on the first checkout, not only on retries. This is the most common multi-child
case (siblings at the same time slot), so it MUST be fixed before go-live.

Fix (requires an API + DB change, NOT snippet-only):

1. **DB migration** (`pnpm db:generate`, never hand-write journal timestamps):
   add `hold_key varchar(64)` (nullable) to `bookings`.
2. **createHold**: accept an optional `holdKey`; include it in the reuse match
   (so reuse only refreshes the SAME line across retries) and store it on
   insert.
3. **wcHoldSchema + `/rounds/hold/wc`**: accept `holdKey`, pass through.
4. **Snippet**: send `'holdKey' => $values['memesh_uid']` in the hold body. The
   uid is stable across payment retries (cart persists), so retries still reuse
   (no leak — the 2/60 fix holds) while two different children get two holds.
5. **Tests** (`rounds-hold.test.ts`): two holds, same customer+round+type,
   different holdKey → two `held` rows; same holdKey retry → one row reused.

The customer-app `/rounds/hold` path is unaffected (never opts into reuse), so
`holdKey` is optional and backward compatible.

## Approach (snippet part — done) — plus the API fix above

1. **Unique line per pick.** In `woocommerce_add_cart_item_data`, stamp every
   round-product add with `memesh_uid = wp_generate_uuid4()`. Each child
   becomes its own cart line, never merged into qty 2. This is both the
   multi-child enabler and the oversell guard (one line ⇒ one held seat).
2. **Allow the second child.** Remove the blocking
   `if ($existing === (int) $product_id) return false;` line. Keep the
   punch-card upsell notice (Yanay's revenue nudge) exactly as is.
3. **Lock the cart quantity.** Add a `woocommerce_cart_item_quantity` filter
   that returns a static `1` for round-ticket lines and the companion line —
   removes the `+` regardless of the theme's custom stepper. `sold_individually`
   stays as a backstop.
4. **Defense in depth at checkout.** In the hold hook: reject a round line with
   quantity > 1 (should be impossible after 1+3, but the money boundary must
   guarantee one seat per paid child), and name the date in the "round filled"
   error so the parent knows which line to fix.
5. **Discoverability nudge.** After a child is added, a short guidance notice
   ("added — add another child, even on a different date, or checkout"),
   because the flow returns to the product page and the option to add another
   is otherwise not obvious to a first-time parent. Tunable/removable; flagged
   for Yanay's copy review.

The picker JS, calendar, companion pairing, name-folding, upsell, and hold
logic are all left untouched. A consolidated in-page "children in cart" roster
(edit/remove per child, live total) is a deliberate **phase 2** — it is a
rewrite of working picker JS and not needed to satisfy the ask.

## Alternatives rejected

- **AJAX add-and-stay roster now.** Best UX, but it rewrites proven picker JS
  and fights every theme's cart-drawer/fragment behavior. High risk for a live
  checkout; the native form-POST repeat already delivers different-dates
  multi-child. Revisit as phase 2.
- **Single cart line holding N structured picks / quantity+count on the hold
  API.** Both touch the one-seat-per-hold invariant that is the safety rail.
  Not worth the risk when one-line-per-child maps cleanly to the existing
  engine.

## Security

- No new endpoints, no new auth surface, no API/DB change. `memesh_uid` is an
  opaque per-line token, never rendered, never trusted server-side (the hold
  still authenticates with the shared secret and resolves the customer from
  checkout identity).
- The checkout qty>1 rejection and the unchanged add-to-cart validation keep
  the invariant: a rounds-required paid line always has exactly one held seat.
  A full round still fails the whole checkout before order creation — no
  partial charge.

## Observability

- Existing `[rounds hold wc] created` logs one line per child at checkout —
  multi-child shows as N log lines, already keyed by roundInstanceId. No new
  logs needed on the API. Snippet-side failures already throw visible WC
  notices.

## Settings

- No new settings. Behaviour is uniform (each child its own line, qty locked
  to 1). Nothing here a user would want to toggle. The nudge copy is the only
  tunable and lives inline for Yanay to approve.

## Testing (results)

- `rounds-hold.test.ts`: new case — two children on one round with distinct
  `holdKey` get two seats; each line reuses on retry (no leak). Fails on the old
  code (reuse collapses them). **9/9 pass.**
- Full `@memesh/db` suite: **433/433 pass** (added column touches every
  `bookings` reader — no regression).
- `apps/api rounds-booking.test.ts`: **41/41 pass.**
- `@memesh/db` and `@memesh/api` typecheck clean.
- Migration `0029_complete_brother_voodoo.sql` = one additive nullable column;
  journal CLI-stamped and monotonic (1783415360154 > 0028).

Manual QA still required against a real WC staging cart (no PHP test harness in
this repo — flagged): the seven scenarios below.

- The WordPress snippet has **no
  PHP test harness in this repo** (flagged per the testing rule) — validation
  is manual against a WC staging cart:
  1. Two kids, different dates → two cart lines, each its own round, checkout
     mints two bookings.
  2. Two kids, same age, same round → two distinct lines (uid), two holds.
  3. Cart shows no `+` / quantity control on ticket or companion lines.
  4. Companion pairing still adds/removes with its ticket per line.
  5. Free-play/off-date ticket still buyable (no round required).
  6. One child's round full at checkout → whole checkout blocked with the
     dated message, no order created, no charge.
  7. Punch-card upsell still shows when a second ticket is added.

## Deploy

- Snippet-only change. Canonical copy updated at
  `wordpress/memesh-rounds-snippet.php` (with the secret PLACEHOLDER). The real
  runtime change is a **manual paste by Yanay** into WP Admin → Snippets, via
  the private txt handoff (secret injected, per the WC-rounds integration
  note). Nothing touches `main`-tracked production infra or the API.
- Rollback: paste the previous snippet revision back. No data migration, so
  rollback is instant and clean.
