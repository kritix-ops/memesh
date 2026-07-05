# Day-strip availability calendar in the punch booking flow (Yanay pick: variant B)

## Goals

Yanay's third dashboard item: see availability "by colors, what and where is free"
without poking a blind date picker. He chose variant B of the three mockups
(2026-07-05): a horizontal strip of upcoming days, each with a status dot, and the
selected day's rounds listed right below - the closest shape to the studio app he
uses. This replaces the bare date input inside the punch-card booking form.

## Approach

**DB** (`packages/db/src/rounds-availability-range.ts`, new): a composed helper
`roundAvailabilityRange(db, fromIso, days, now)` returning one row per day:
`{ date, roundsRequired, rounds }`. It mirrors the single-date route's composition
exactly - master switch + anyActiveRounds once, then per date: resolve the winning
schedule rule, filter rounds that fit its windows entirely, and derive
`roundsRequired` from the rule's outside behavior, with the same seat-count
predicate as the single-date read.

Performance (Yoav 2026-07-05, "takes a while to load"): the first version
looped the per-date helpers - about 5 queries per day, 150 for a month - which
made the picker visibly slow to open. It now runs 5 queries total regardless
of range: settings, any-active-rounds, all rules once (resolved per date with
the pure `resolveScheduleFromRules`), all instances in the range once, and one
grouped booking-count query. The existing range tests double as the
behavior-parity check for the rewrite.

**API** (`apps/api/src/routes/rounds-booking.ts`): `GET /rounds/availability-range`
with optional `from` (default: venue today via `venueTodayIso` - the API host is
UTC, never the server clock) and optional `days` (default 14, max 31 - the whole
30-day instance horizon, so the pickers keep the reach the old free date inputs
had). Public and rate-limited like the single-date endpoint but at half the rate
(heavier query). Same public shape per day as the existing endpoint, plus
`companionPriceIls` once. The single-date endpoint stays untouched - the WP
snippet's server-side validation still uses it.

**UI** (`apps/customer/src/customer/CustomerApp.tsx`): the punch booking form
loads the 14-day range when opened. The date input is replaced by a scrollable
chip strip - weekday letter, day number, and a status dot per day (green = plenty,
amber = quarter or less left, red = full, light gray = free-play or nothing
offered). Tapping a chip shows that day's rounds from the already-loaded payload -
no second fetch. The first chip is today, labeled "היום", selected on open. The
rest of the flow (round pick, count stepper, companion upsell, waitlist for full
rounds) is unchanged. After a successful booking the range is refetched so the
dots stay honest.

Day dot derivation (client-side, from the day's rounds):
- day marked `closed` by the API → dark gray "סגור" (detail: "המקום סגור בתאריך זה")
- no rounds offered and not required → free-play (dashed gray, detail shows the
  existing "כניסה חופשית" notice)
- no rounds offered but required → gray (detail shows "אין סבבים פנויים")
- else by total remaining across open rounds: 0 → red; ≤25% of capacity → amber;
  otherwise green.

**Closed days** (Yoav 2026-07-05): `DayAvailability.closed` is true only when a
schedule rule with outside=closed leaves nothing bookable on the day — an
explicit admin decision, distinct from "no rounds happen to exist" (no rule /
past the horizon), which stays gray "אין סבבים". The admin rule form now shows
the day-behavior toggle even with zero time windows (it was hidden before, so
an all-day closed rule was impossible to create): scope the days, leave windows
empty, pick "המקום סגור — אין מכירה".

**Round titles** (Yoav 2026-07-05): admins name rounds with the hours embedded
("בוקר 9:00 - 14:00"), and screens that appended startTime–endTime printed the
hours twice. `labelHasTime`/`roundTitle` in web-shared now gate every
label+hours render (staff tiles, customer rows/waitlist/booking cards, WP rows,
swap picker): the hours line appears only when the name doesn't carry one.

**WordPress** (`wordpress/memesh-rounds-snippet.php`, Yanay 2026-07-05): the
entry-product picker becomes the same day strip - one availability-range call
(31 days) renders the chips with dots and the chosen day's rounds as tappable
rows, replacing the date input + dropdown. Selections fill the same hidden form
fields (`memesh_date`, `memesh_round_instance_id`, `memesh_round_times`) the
checkout hold already reads, and server-side validation is unchanged. The
add-to-cart button is disabled until the selection is valid (the browser
`required` guard left with the old select). All DOM is built with
createElement - API data is never concatenated into HTML. Free-play days show
an explicit "בלי סבב - כניסה חופשית" row when rounds are optional. The strip
fails closed like the old picker: fetch error → message + button stays
disabled. Deploy note: the API (PR with this plan) must be live before Yanay
pastes the new snippet, since the picker needs the range endpoint.

**Staff** (`apps/staff/src/RoundsView.tsx`, Yoav clarification 2026-07-05): the
same two-week strip sits above the occupancy tiles in the staff סבבים page as a
quick day jumper. The existing arrows + date input stay (staff sometimes needs
arbitrary or past dates). Dots there use the staff palette and the SAME
warn/danger occupancy thresholds as the tiles (from staff rounds settings), so
strip and tiles never disagree. The strip refreshes on the page's existing
auto-refresh tick.

## Rejected alternatives

- Month-grid variants (A, C): Yanay explicitly picked B after seeing all three
  live.
- Keeping the per-date fetch and calling it 14 times from the client: 14 round
  trips on every form open versus one; the strip needs all dots at once.
- A day-level summary endpoint + per-day detail fetch: two endpoints to maintain
  for a payload that is small anyway (14 days × a handful of rounds).

## Security

Same posture as the existing public availability endpoint: aggregate seat counts
only, no booking internals, no customer data. `days` is clamped server-side
(1..21) so the range cannot be abused as an amplification query; rate limit 30/min.

## Observability

- Server: `request.log.info('[rounds availability-range]', { from, days, daysWithRounds })`.
- Client: `console.info('[customer punch-booking] range loaded', { from, days, error? })`
  on load, plus the existing booking submit log.

## Settings

Strip length is a constant (14 days) - matches the instance materialization
horizon and keeps the payload flat. Not exposed as a setting: no realistic user
would tune it, and the admin already controls what appears via schedule rules and
round activation. Dot thresholds (25%) are also constants for the same reason.

## Testing

- `packages/db/src/rounds-availability-range.test.ts` (new): default all-rounds
  day, free-play rule day (rounds offered but optional / none offered), closed
  rule filtering, master switch off, bookings reducing availability, day count
  and date sequence.
- Route tests: public (no auth), `days` out of range → 400, malformed `from` →
  400, valid → documented shape.
- Full db + api suites, customer typecheck. Known baseline: staff png-import
  failures are pre-existing, not a gate.

## Deploy

Stacked branch: `feat/rounds-day-strip` on top of `feat/dashboard-punch-booking-cleanup`
(merged with origin/main for the venue-timezone helpers). PR order: punch-booking
cleanup first, then this. Production tracks main; nothing is pushed without
explicit approval. Additive API only - no breaking change for the WP snippet or
old clients.
