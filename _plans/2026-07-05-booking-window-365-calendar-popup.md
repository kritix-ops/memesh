# Booking window to 365 days + calendar popup + price-list purchase

Date: 2026-07-05
Requested by: Yanay (WhatsApp, 2026-07-05) via Yoav
Decisions locked by Yoav: fixed 365-day window; price-list cards get a buy
button that opens a popup picker; the month/year calendar button lands on all
three pickers (WP product pages, customer dashboard, staff rounds view).

## Goals

1. Customers can book rounds up to 365 days ahead ("otherwise they nag us all
   day" - Yanay). Today the hard limit is 30 days.
2. Every day-strip picker gains a calendar button that opens a month-grid
   popup so users can jump to any future month inside the window.
3. The price-list page (memesh.co.il/price-list) becomes a purchase surface
   for the two entry tickets (products 300 + 304): a button on each card opens
   a popup with the same picker and adds to the WooCommerce cart.

## Constraints and facts (verified in code, origin/main)

- Instances are materialized 30 days ahead (`INSTANCE_HORIZON_DAYS = 30`,
  packages/db/src/rounds.ts) and topped up ONLY when the admin opens the
  rounds list (rounds-admin.ts calls ensureAllActiveInstances). Unreliable at
  any horizon; unacceptable at 365.
- `ensureUpcomingInstances` uses onConflictDoNothing: existing rows are never
  touched. That is how per-date overrides/closures survive, but it also means
  template capacity edits never reach already-minted dates.
- Instance rows carry ONLY (roundId, date, capacity, isClosed). Labels and
  times come from the template at read time, and availability filters
  rounds.isActive, so label/time/deactivation changes already propagate.
  The propagation gap is exactly: capacity edits and weekday removals.
- /rounds/availability-range already accepts `from` + `days<=31` and is
  batched (5 queries per call). Month-by-month paging needs no read changes.
- The price-list page is Elementor (Hello Elementor + Elementor Pro 4.1.2);
  the two ticket cards are static heading/text widgets with no purchase path.
  Elementor Pro popups are available.
- Cron infra exists: apps/api-deploy/vercel.json crons + /cron/* routes.

## Chosen approach (LLM Council verdict, 2026-07-05, unanimous peer review)

Record divergence intent explicitly instead of guessing it:

1. **Schema**: add `capacity_overridden boolean not null default false` to
   `round_instances`. One-time backfill: set true where capacity differs from
   the parent round's default_capacity (conservative: divergence = intent).
2. **Admin per-date edit** sets capacityOverridden = true when capacity is
   changed for a specific date (closures keep using isClosed, unchanged).
3. **Template update propagation** (in updateRound):
   - defaultCapacity change: update future (>= venue today) instances where
     capacityOverridden = false AND the instance has no bookings (any
     status). Instances skipped because of bookings are returned to the
     admin UI as a plain list so nothing is silent.
   - weekday removed from daysActive: delete future instances on that
     weekday that have no bookings (any status); booked ones are kept and
     reported in the same list.
4. **Horizon**: INSTANCE_HORIZON_DAYS 30 -> 365. availability-range keeps its
   31-day per-request cap; clients page month by month. The response gains
   the window end (`maxDate`) so calendars know where to stop.
5. **Reliability**: new daily cron /cron/rounds-instances-topup (vercel.json
   entry) running ensureAllActiveInstances. The existing top-up on the admin
   list read stays as a belt-and-braces path (it is already written and one
   conflict-ignored insert per round).
6. **Calendar popup UI** on all three strips: a calendar button beside the
   strip opens a month grid (same status-dot logic per day), with next/prev
   month arrows bounded by [today, maxDate]. Picking a day loads it into the
   existing strip/rounds flow.
7. **Price list**: new shortcode in the WP snippet, e.g.
   [memesh_round_picker product_id="300"], rendering the same picker plus an
   add-to-cart form; Yanay places buy buttons on the two cards that open
   Elementor Pro popups containing the shortcode. Delivery notes txt tells
   him exactly how (he pastes, he clicks, nothing to configure).

## Rejected alternatives (and why)

- Pre-mint 365 with no propagation: capacity edits take effect a year later;
  a known bug with a one-year fuse.
- Heuristic propagation (update where capacity = old default): silently
  fails on double edits and clobbers overrides equal to the old default;
  haunted behavior for a non-technical admin.
- Virtual availability + mint-at-hold (roundId, date): architecturally the
  cleanest, but a dual-identifier refactor across the hold API and three
  clients (incl. the paste-deployed WP snippet) for bookings that will be
  rare. Over-engineering for one venue with ~5 templates.
- Materialize-on-view: writes on read and only defers the freeze problem.
- 90/120-day window: cheaper risk profile, but the owner explicitly chose
  365 after the tradeoff was flagged.

## Known risks / open questions

- Jewish holidays: 365 days of weekday minting makes holidays bookable by
  default. Yanay MUST close holiday dates via the per-date closure panel;
  goes in his delivery notes. Possible follow-up: an Israeli-holidays helper
  in the admin.
- Schedule changes vs. existing far-future bookings: propagation skips booked
  dates and reports them; contacting/refunding those customers is a manual
  business process (Yanay), not automated in this build.
- Punch-card upsell copy already promises "book a future round any time";
  the longer window strengthens it, no change needed.

## Security

- No new endpoints with write access except the cron route, which follows the
  existing cron auth pattern (Vercel cron secret header check, same as
  rounds-hold-sweep). The shortcode renders server-side in WP with the same
  escaping discipline as the existing picker (createElement only, no HTML
  concatenation of API data). No new secrets. Rate limits on
  availability-range unchanged (30/min covers 12-month paging).

## Observability

- Cron logs `[rounds instances-topup]` with per-round counts.
- Propagation logs `[rounds propagate]` with round id, old/new capacity,
  updated count, skipped (booked) dates, deleted count.
- Calendar popup logs `[rounds calendar]` month loads + errors in all three
  clients (console.info pattern already used in staff view).
- WP snippet logs picker/calendar fetch failures to console with a
  [memesh picker] prefix.

## Settings

- Intentionally NOT exposing a "booking window" admin setting: Yoav chose a
  fixed 365-day window after the tradeoff was flagged. If Yanay later wants
  control, the constant is a one-line change or a future round-settings knob.
- No other new user-facing settings; the calendar popup inherits the strip's
  existing look.

## Testing

- packages/db: propagation unit tests (capacity edit updates non-overridden
  unbooked instances; skips booked + reports them; skips overridden; weekday
  removal deletes unbooked only; double-edit propagates correctly; backfill
  marks diverged rows), horizon tests (365 minting), availability-range far
  month test.
- apps/api: cron route test (auth + happy path), availability-range maxDate
  test, rounds-admin PUT returns skipped dates.
- Frontends: calendar popup logic tests where the apps have test seams;
  manual QA walk of all three pickers (golden path, closed month, empty far
  month, RTL layout, mobile).
- Known baseline failure: apps/staff staff.test.ts (.png import) is
  pre-existing and not a regression.

## Deploy

- Branch flow: feature branches -> PR -> main; main is production-tracking
  (Vercel). Never push main directly; Yoav approves every push/PR.
- Order matters: backend PR (schema + cron + propagation + horizon) deploys
  FIRST. The WP snippet update is pasted by Yanay only after the API is
  live, same as the day-strip rollout (his notes say this explicitly).
- Migration adds a nullable-free boolean column with default false +
  backfill UPDATE; safe on live data; journal timestamp must stay monotonic
  (lesson from fix/migration-journal-monotonic).
- Rollback: revert the merge commit; the new column is additive and inert
  without the code, and the cron route 404s harmlessly if reverted.

## Work plan (PRs)

1. feat/booking-window-365: schema + backfill migration, override flag on
   per-date edit, deterministic propagation + skipped-dates report, horizon
   365, daily cron, availability-range maxDate, admin UI list of skipped
   dates, tests.
2. feat/rounds-calendar-popup: month-grid popup component in customer
   dashboard + staff view (shared styling per app), bounded by maxDate.
3. feat/wp-snippet-calendar-shortcode: WP snippet calendar popup + month
   paging, [memesh_round_picker] shortcode, price-list popup wiring, updated
   delivery txt for Yanay (including the holiday-closure warning).
