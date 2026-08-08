# Lower round capacity must reach booked future instances when the bookings still fit

Date: 2026-08-08
Branch: fix/round-capacity-lower
Requested by: Yanay (product owner)

## Problem

Yanay lowered a round's capacity from 60 to 50. Existing upcoming instances
kept 60, even when only 4 people were registered. Cause: the template-edit
sweep in `propagateRoundTemplateChange` froze ANY future instance with taken
seats, regardless of whether the new capacity could still hold them.

## Chosen approach

Replace the boolean "seats taken?" guard with a per-instance count compare,
using the exact seat predicate availability uses (super-brief §1.3: confirmed
+ used + unexpired holds):

- taken <= new capacity → the instance follows the template edit
- taken > new capacity → kept at its old capacity and reported in
  `capacityKeptDates` (shrinking below existing bookings is a human decision)

Hand-overridden dates (`capacity_overridden`) are still never touched.
The weekday-removal branch is unchanged (any booking row anchors history).

## Rejected alternatives

- Force the new capacity onto every date and let oversold dates go negative:
  breaks the availability invariant and could oversell walk-ins.
- Auto-cancel or waitlist the overflow when shrinking below bookings: money
  and customer-contact decisions do not belong in a silent sweep.

## Side effects (intended)

Raising capacity now also reaches booked dates (previously frozen too). Same
principle: propagate whenever the bookings still fit.

## UI

Admin Rounds form warning copy updated: kept dates are now explained as
"more registrations than the new capacity, or a removed weekday with
bookings" instead of "already has bookings".

## Testing

`packages/db/src/rounds-propagation.test.ts` (PGlite):
- regression: 60→50 with 4 bookings propagates everywhere, nothing kept
  (fails on the old code)
- guard: 4 bookings, cut to 2 → date kept at old capacity and reported
- rewritten: raise with a booking now propagates instead of freezing

## Security / observability / settings / deploy

- No new inputs, no auth changes; sweep still runs only via the admin
  updateRound path.
- Existing `[web admin rounds]` console logs still report kept dates.
- No new settings; the oversell guard is an invariant, not a preference.
- Ships as one PR into main via the normal pipeline; no migration.
