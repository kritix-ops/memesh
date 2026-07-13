# Admin: reach round participant management for any date (remove/move/walk-in)

Date: 2026-07-13
Origin: Yanay/Yoav product feedback (WhatsApp) — "let me kick people out of a סבב" + "I can't see it outside active hours." Council skipped per standing note on Yanay-originated asks.
Branch base: new branch off `main` per deploy rules.

## The ask (verbatim intent)

1. Admin can remove/kick a participant from a round — including his own test bookings on future dates.
2. Admin can see the round/participant view even outside operating hours (no live round right now).

## Key grounding fact (why this is small)

The whole participant-management stack — list attendees, remove, move, add walk-in — **already exists and already works for any round on any date** server-side:

- `GET /staff/rounds/today?date=YYYY-MM-DD` reads any day (`staff-rounds.ts:157`, built for Yanay 2026-07-04).
- `GET /staff/rounds/:id/attendees`, `POST .../move`, `POST .../:id/walk-in`, `POST .../bookings/:id/cancel` (remove) have **no date gate**. Only *arrival marking* is venue-today-only, and the panel doesn't do arrival.

The single limitation is the **admin UI**: `LiveRoundsDashboard` renders the panel only for `data.today.rounds` (the live dashboard's today-scoped list). Outside operating hours it shows "אין סבבים פעילים היום" and there's nothing to open. So this is a **frontend-only reachability fix** — no backend, no DB, no money-path change.

## Chosen approach — date selector on the dashboard rounds zone

- **Today stays the default and unchanged**: the rich live view (occupancy, holds, stats, alerts, week-ahead) renders from `getDashboardLive` exactly as today. Zero regression risk for the common case.
- Add a native `<input type="date">` (matching the Tickets/Rounds pattern) to the rounds zone header.
- Picking another date fetches that date's rounds via the existing staff endpoint and renders the **same** `RoundTile`s → the **same** `RoundAttendeesPanel` (remove/move/walk-in), with move-targets scoped to that date.
- Non-today reads as a clear "browsing [date]" mode with a "חזרה להיום" reset; today's live view is one tap away.
- Venue-today is derived client-side with `Intl` + `Asia/Jerusalem` (matches the server's hardcoded `VENUE_TZ`) so "today vs other date" is stable regardless of the admin's own timezone.

### Data source

- New admin client `getStaffRoundsForDate(date)` → `GET /staff/rounds/today?date=`. The endpoint returns a superset of `DashboardLiveRound`; typed to the subset the tile needs. Today's rounds from this endpoint are identical to `data.today.rounds` (same DB helper `dashboardLiveRoundsForDate`), so reuse is exact.
- Today keeps rendering from the live payload (no extra fetch, no second loading state). Only a non-today selection triggers the staff-endpoint fetch. After any panel action the currently-viewed date refreshes (live → `load()`, date → refetch).

## Alternatives rejected

- **Dedicated "rounds calendar / participants" screen.** Scales better if participant management becomes a daily heavy task, but a bigger build and *worse* discoverability — Yanay already looks at the dashboard. Revisit only if usage proves heavy.
- **Make week-ahead grid cells clickable.** Clever but undiscoverable, and past dates aren't in the 7-day grid. No.
- **Backend: add `date` to the dashboard response / a new admin rounds endpoint.** Unnecessary — the staff endpoint already serves any date and the admin role passes its `STAFF` gate.

## Security (rule 13)

- No new endpoints, no new surface. Remove stays `requireRoleHook('admin')`; attendees/move/walk-in stay `STAFF`-gated. A manager who taps remove still gets the existing 403 → "רק אדמין יכול להסיר משתתף."
- No money-path change. Paid removals keep failing closed (`refund_failed`) until the Grow refund fix lands; punch-card removals work now. This UI flips paid removals on automatically once Grow is wired — no rework.

## QA (rule 6)

- Golden: today unchanged; pick a future date with a test booking → tiles render → open panel → remove a punch-card booking → seat frees, list refreshes.
- Edge: date with no rounds → "אין סבבים…"; a paid booking removal → clear refund-failed message (unchanged); switch dates with a panel open → selection resets; date fetch error → error card, today still reachable.
- `pnpm --filter @memesh/admin typecheck` + the admin test suite green. New client test mirrors the existing `listRoundsForDate` test.

## Open questions

- Poll non-today occupancy? Deferred — a date view is a snapshot refreshed on select + after actions. Add polling only if stale future-occupancy is reported.
