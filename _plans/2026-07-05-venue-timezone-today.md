# Venue timezone for "today" (rounds + dashboard)

Date: 2026-07-05
Branch: fix/venue-timezone-today
Status: approved (Yoav, 2026-07-05: "timezone should always be Israel")

## The bug

At 00:10 Sunday (Israel) the staff panel said "אין סבבים היום" while the admin
showed the round active on Sundays. Root cause: the API server runs on UTC, and
every place that asks "what date is today" used the server's local clock
(`new Date()` + getFullYear/getMonth/getDate). Between 00:00 and 03:00 Israel
time (IDT) the server still thinks it is yesterday.

Observed effects, all confirmed against production screenshots:

- Staff "סבבי היום" queried Saturday and returned nothing, while the header
  showed Sunday (client-local date).
- Admin "N תאריכים קרובים" showed 21 instead of 22 because the 30-day window
  started on the server's Saturday.
- The admin live dashboard, waitlist zone, week-ahead grid, and day-over-day
  stats all shift a day during that window.

## Goal

Every "today" / day-boundary computation on the server uses Asia/Jerusalem,
regardless of the host timezone. The staff client always sends an explicit
date so the displayed date and the queried date can never diverge.

## Approach chosen

Extend packages/db/src/round-time.ts (the existing venue-TZ module, already
exported from @memesh/db) with calendar helpers:

- venueTodayIso(now) - 'YYYY-MM-DD' of now in Asia/Jerusalem
- venueStartOfDay(now) - the instant the venue's current day began
  (venue midnight; within a DST-transition day it can be off by 1h, the same
  accepted convention as the rest of round-time.ts)
- addIsoDays(dateIso, days) - pure calendar math on ISO strings
- isoWeekday(dateIso) - 0=Sunday..6=Saturday, matches the daysActive bitmask

Then swap the server-local date math for these helpers in:

- packages/db/src/rounds.ts: ensureUpcomingInstances (window start + weekday
  test now in venue frame), countUpcomingInstances, listCustomerRoundBookings
- packages/db/src/rounds-dashboard.ts: dashboardLiveRoundsToday,
  dashboardLiveStats (day boundaries), dashboardLiveWaitlist,
  dashboardLiveWeekAhead
- packages/db/src/rounds-reminders.ts: use the named helper instead of the
  inline venueWallMs->toISOString trick (behavior unchanged; one source of
  truth)
- apps/api/src/routes/staff-rounds.ts: todayIso
- apps/staff/src/RoundsView.tsx: always pass the explicit date to
  getStaffRounds

## Alternatives rejected

- Set TZ=Asia/Jerusalem on the server host/deployment. Works but is invisible
  config that silently breaks on redeploy/migration, and tests would still
  pass or fail depending on the runner's TZ. Explicit code wins.
- Client sends its own "today" and server trusts it. Fixes only the staff
  view; materialization, dashboard, and stats would still shift. Also trusts
  device clocks.

## Not in scope

- The WordPress snippet's date-picker min attribute uses PHP date('Y-m-d')
  (WP default TZ is UTC), so between 00:00-03:00 Israel time it lets the buyer
  pick yesterday. Harmless (availability for yesterday returns nothing
  bookable) but worth switching to wp_date() in the next snippet version sent
  to Yanay.
- rounds-schedule.ts weekdayOf: already TZ-safe (weekday of an explicit ISO
  date is the same in every zone).
- /rounds/availability: requires an explicit date param, nothing to fix.

## Security

No new inputs, no auth changes, read paths only. The staff endpoint already
validates the date param shape.

## Observability

Existing logs already include the resolved date ([staff rounds] served,
[rounds availability]). No new logging needed; the served date now matches the
venue day.

## Settings

Nothing to expose. The venue timezone is a business constant (one venue, in
Israel), not a user choice.

## Testing

- round-time.test.ts: venueTodayIso / venueStartOfDay across the midnight-UTC
  gap and summer/winter offsets; addIsoDays month/year rollover; isoWeekday.
  These are machine-TZ independent (Intl with explicit timeZone).
- rounds-crud.test.ts: materialization + countUpcomingInstances with
  now = 2026-07-04T21:10Z (venue Sunday 00:10): the window starts on the venue
  Sunday, nothing lands on the server's Saturday.
- rounds-dashboard.test.ts: rounds-today returns the venue-date instance at
  the same instant; existing tests reseeded via venueTodayIso so they stay
  deterministic on a UTC CI runner.
- Note: on an Israel-TZ dev machine the old code passes the integration tests
  too (local frame == venue frame); the helper unit tests carry the regression
  proof on any machine, and the integration tests would fail on old code on a
  UTC runner.

## Deploy

Standard flow: branch -> PR into main -> merge triggers production deploy.
No env, schema, or WP-snippet changes. Rollback = revert the merge commit.
Known baseline failure: admin staff.test.ts (.png import under node --test)
is pre-existing and unrelated.
