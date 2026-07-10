# Personal area: reschedule to another DATE, not just another time

Date: 2026-07-10
Source: Yanay's WhatsApp, 2026-07-09 21:52-21:53. A booking card offered only
"שנה שעה", the picker was hardcoded to the same day ("בחרו זמן אחר לאותו
יום"), and a day with a single round dead-ended on "אין זמנים פנויים אחרים
היום" while also hiding the change/cancel buttons. His rule: a customer may
change time OR date, up to the hour of the original booking.

## Key finding

The backend already implements his rule exactly: swapBooking
(packages/db/src/rounds-swap.ts) has no same-day restriction — its only
customer gate is `isBeforeRoundStart` on the ORIGINAL round. The same-day
limit was a frontend-only choice. No API change shipped.

## Approach (apps/customer/src/customer/CustomerApp.tsx)

1. Extracted the day-window logic that already powered punch booking into a
   shared layer, per the SSOT rule (two copies of "what does this day look
   like" is how pickers drift):
   - `useRoundAvailabilityWindow(open, logNs, defaultDate?)` — range fetch,
     day cache, month-calendar paging, selection. `defaultDate` preselects a
     date once loaded (the reschedule flow passes the booking's date); a
     default beyond the 31-day strip loads its month first.
   - `DayStrip`, `DayDotLegend`, `RoundChoiceRow` — presentational pieces
     moved verbatim from the punch flow.
   - `pickInitialDate`, `swapTargetsForDay` — exported pure helpers, unit
     tested.
2. PunchRoundBooking refactored onto the shared layer; behavior unchanged
   (verified by the existing UI copy paths and typecheck; no renderer tests
   exist in this repo).
3. RoundBookingCard: "שנה שעה" → "שנה מועד"; the picker is now the familiar
   strip + calendar preselected to the booking's date, listing that day's
   other rounds; any open day is one tap away, killing the dead-end. Dismiss
   renamed "ביטול" → "חזרה" (it sat next to "בטל הזמנה" and read as its twin).
   A muted line states the rule: "אפשר לשנות מועד עד שעת ההתחלה של ההזמנה
   המקורית." The too_late error names the rule too.

## Alternatives rejected

- New date-picking UI just for reschedule: a second picker to learn for the
  customer and a second implementation to maintain. Reuse won.
- Hiding "שנה מועד" client-side once the round started: the server already
  rejects with too_late, and client clocks lie; the honest error beats a
  silently missing button.

## Security

No new endpoints or inputs. The swap stays owner-checked, capacity-checked
and time-gated server-side under row locks; the UI is a viewer over
availability data that is already public.

## Observability

`[customer reschedule]` namespace: picker opened (bookingId, date), calendar
pick, swapping (from/to), swap rejected (error), swap done. The shared hook
logs range/calendar-month loads under each flow's own namespace.

## Settings

Nothing new to expose: the booking window and round availability are already
admin-controlled; the timing rule is the product invariant, not a knob.

## Testing

`CustomerApp-reschedule.test.ts` (added to the customer test script, which now
registers @memesh/brand's png-stub loader so importing CustomerApp.tsx works
under node --test):
- pickInitialDate: current kept, default preferred, fallback to today, empty
  window → null.
- swapTargetsForDay: excludes the booking's own round, drops full/closed,
  keeps all open rounds on other days, and pins the exact one-round-same-day
  dead-end Yanay screenshotted (now messaged instead of dead-ending).
- Source contracts: "שנה מועד" exists, "לאותו יום" is gone, both flows call
  the shared hook (SSOT guard).
Server-side timing/capacity rules stay covered by rounds-swap tests in
packages/db. Suite run: customer 2/2 files pass. Out of scope: React renderer
tests (repo has no renderer harness — repo-wide convention).

## Deploy

Branch `feat/customer-reschedule-date` → PR into `main`; standard pipeline
deploys the customer app. Note: this branch and `fix/checkout-complete-copy`
both touch the customer test script line — a one-line merge conflict for
whichever lands second. Rollback: revert the merge commit.
