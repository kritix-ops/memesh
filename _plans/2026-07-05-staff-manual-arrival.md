# Manual arrival marking for round bookings (Yanay, 2026-07-05)

## Goals

Yanay: "תגיד איך הצוות מסמן שהלקוח הגיע?". The floor often doesn't scan — staff
mark arrivals by hand. Today they can't: the booking QR is minted but there is
NO redemption path anywhere (the POS scanner only understands punch-card
tokens), so a booking's arrived flag could never turn true. This feature is the
first working check-in, done the way the floor actually works: a tap.

Two surfaces, matching how staff find a customer:
1. The rounds page attendee list ("מי הגיע?") — the natural place when working
   a round.
2. The POS customer screen — search a customer in לקוחות, see their bookings
   for today, mark them in. Covers both paid tickets and punch-card bookings
   (a booking is a booking; the unique number/QR already exists on it).

## Approach

**DB** (`packages/db/src/rounds-arrival.ts`, new):
- `setBookingArrival(db, { bookingId, arrived }, now)` — one transaction with a
  row lock. arrived=true: confirmed → used + usedAt=now. arrived=false (undo a
  mistaken tap): used → confirmed, usedAt cleared. Idempotent in both
  directions (`changed: false` replays). Guards: booking must exist
  (`not_found`), must be confirmed/used (`not_markable` for held/cancelled),
  and its round must be on the venue-local TODAY (`not_today`) — arrival is a
  physical fact, not something to backfill or pre-fill. Marking arrived also
  naturally blocks cancellation (cancel requires confirmed), which is correct:
  they entered.
- `listCustomerRoundBookingsForDate(db, customerId, dateIso)` — the customer's
  bookings on one date with label/times/status/usedAt/source, sorted by start
  time. Powers the POS section.

**API** (`apps/api/src/routes/staff-rounds.ts`, all staff roles like the rest
of the floor endpoints):
- `POST /staff/rounds/bookings/:bookingId/arrival` body `{ arrived: boolean }`.
- `GET /staff/customers/:customerId/rounds-today` — venue-today bookings.

**Staff rounds page** (`apps/staff/src/RoundsView.tsx`): each attendee row gets
the control where the static status text was — not arrived: a solid green
"סמן הגעה" button; arrived: "✓ הגיעו HH:MM" with a quiet "ביטול" underneath.
Buttons render only when the page is showing today (the server enforces it
anyway). Marking updates the row instantly and refreshes the tiles so the
"הגיעו X מתוך Y" counter moves with it.

**POS customer screen** (`apps/staff/src/pos/PosApp.tsx`): a self-contained
`CustomerRoundsToday` card under the customer header — fetches its own data
(same pattern as AttendeesSection), lists today's bookings with the same
mark/undo control, shows nothing extra when the customer has no bookings
today. No prop-drilling through PosApp's state tree.

## Rejected alternatives

- Building the full QR door-scan for bookings first: bigger feature, and Yanay
  explicitly said the floor often doesn't scan. Manual marking is the daily
  path; scanning can come later and will reuse setBookingArrival.
- Marking arrival from the admin dashboard: the floor works on the staff app;
  admin is reporting, not operations.
- Allowing arrival marking on any date: opens silent data drift (pre-checking
  tomorrow, backfilling last week). Venue-today only, fail closed.

## Security

Staff-gated (cashier/manager/admin) like the rest of the floor endpoints. The
undo direction is deliberately allowed for all staff: mistaken taps happen at
the counter and forcing a manager escalation for "oops wrong person" hurts the
queue more than it protects. No new PII exposure — the attendees endpoint
already serves contact details to the same roles. Row lock prevents double-tap
races; the same-day guard bounds the blast radius of any misuse.

## Observability

- Server: `[staff arrival] set` with bookingId, arrived, changed, staff role;
  `[staff customer rounds] served` with customerId + count.
- Client: `[staff attendees] mark` / `[pos customer rounds]` info logs with ids
  and results, matching the existing bracketed-namespace style.

## Settings

Nothing exposed. Undo permission could become a role knob later if abuse shows
up; starting open keeps the counter fast (rule: prefer one obvious behavior
over a setting nobody asked for).

## Testing

`packages/db/src/rounds-arrival.test.ts` (new): mark flips confirmed→used with
usedAt; re-mark replays (changed=false); undo restores confirmed and clears
usedAt; held/cancelled → not_markable; other-day round → not_today; unknown id
→ not_found; list returns only the requested date's bookings sorted by time.
Route tests: 401 without staff token, 400 bad body/id, valid reaches engine.
Full db + api suites; staff typecheck (staff app has no test runner beyond the
isolation test — UI verified by typecheck + manual pass).

## Deploy

New branch `feat/staff-manual-arrival` off main (independent of PR #78's perf
commit). Standard PR into main; no WP involvement, no snippet change, additive
API only.
