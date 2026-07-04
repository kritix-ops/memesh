# WC hold reuse + "בתהליך תשלום" on the staff panel

Date: 2026-07-04
Status: approved (Yoav, after the Yanay "58/60" report)

## Problem

Yanay saw "2 / 60 ילדים" on the staff rounds panel when only one booking
existed. Production data showed why: the customer submitted WooCommerce
checkout twice. Every checkout attempt re-creates order line items, so the
snippet's `woocommerce_checkout_create_order_line_item` hook called
`/rounds/hold/wc` twice — the first hold was orphaned and pinned a seat for
the full 15-minute TTL. Companions were NOT the cause (capacity counts
booking rows only; companions never take a seat).

Two defects, one cosmetic, one real:

1. Real: every WC checkout retry leaks a hold. On a nearly-full round the
   ghost seat can block a real sale for up to `holdTtlMinutes`.
2. Cosmetic: the staff panel folds active holds into "X / 60 ילדים" with no
   explanation, so a correct number reads as a bug.

## Approach (chosen)

1. **Reuse instead of duplicate, server-side.** `createHold` gains an opt-in
   `reuseActiveHold` flag. When set, an existing active `held` booking for the
   same customer + round instance + ticket type is refreshed (new TTL, updated
   `additional_companions`) and its id returned, instead of inserting a second
   row. Only `/rounds/hold/wc` opts in. Safe there because the WP cart allows
   at most one line per ticket product, so one customer never legitimately
   needs two identical holds on one round via WC checkout.
2. **Panel transparency.** The staff rounds endpoint exposes `heldCount`
   (already computed by `dashboardLiveRoundsForDate`, previously dropped), and
   the round card shows a muted "מתוכם N בתהליך תשלום" line when it is > 0.

## Alternatives rejected

- **WP-snippet release-and-rehold**: needs a new server-to-server release
  endpoint, another snippet paste round-trip through Yanay, and misses
  retries from a fresh session. More moving parts for the same result.
- **Shorter TTL**: band-aid; the ghost seat still appears and slow payers
  get less time to finish paying.

## Security

- The reuse path runs inside the existing hold transaction after the
  round-instance row lock, keyed by customer + instance + ticket type; it
  cannot touch another customer's hold.
- No new endpoints, no new auth surface. The flag is server-internal;
  customer-gated `/rounds/hold` behavior is unchanged.
- `heldCount` is an occupancy count — no PII, no revenue — consistent with
  the staff endpoint's exposure policy.

## Observability

- `[rounds hold wc] created` log line gains `reused: boolean`.
- Staff endpoint response unchanged in shape otherwise; existing
  `[staff rounds] served` line already logs round counts.

## Settings

- No new settings. `holdTtlMinutes` (existing admin setting) still governs
  hold lifetime. The panel line is informational and always on when holds
  exist — hiding it is exactly the confusion we are removing.

## Testing

- `packages/db/rounds-hold.test.ts`: retry reuses the same hold id, refreshes
  expiry, updates companions, and leaves exactly one `held` row (fails on the
  old code); no reuse across ticket types or past-TTL holds; a retry on a
  round that filled up meanwhile still succeeds via reuse.
- `apps/api/staff-rounds.test.ts`: `heldCount` present on round rows.
- Full affected suites run green before done (known pre-existing failure:
  admin staff.test.ts .png import — baseline, unrelated).

## Deploy

- Branch: work lands on `feat/staff-rounds-date-nav` (same staff-panel
  effort). PR into `main` through the normal flow; production tracks `main`.
  No WordPress snippet change required.
- Rollback: revert the PR; the flag is additive and default-off.
