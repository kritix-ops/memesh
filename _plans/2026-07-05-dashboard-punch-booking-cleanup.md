# Dashboard punch-booking cleanup (Yanay feedback, 2026-07-04 WhatsApp)

## Goals

Yanay's dashboard feedback, items 1+2 of 3 (item 3, the availability calendar, gets
its own plan after he picks a mockup):

1. The standalone "הזמנת כניסה לסבב עם הכרטיסייה" button floats between sections and
   its connection to the punch card is not obvious. Move the booking action inside
   each active punch-card card.
2. When the booking form opens, let the customer choose how many punches to spend
   (a parent with two kids books once, not twice). Drop the baby/child toggle from
   this flow — it changes neither price nor capacity for punch bookings and only
   confuses.

## Approach

**Backend** (`packages/db/src/rounds-punch.ts`): `bookRoundWithPunch` gains a
`count` (default 1). Same single transaction: capacity check becomes
`taken + count <= capacity`, card check becomes `used + count <= total`
(new error `not_enough_entries` when the card has some but not enough entries;
`card_exhausted` keeps meaning zero left). N bookings inserted, each with its own
barcode token and its own punch entry (`idempotency_key` = booking id), so the
existing per-booking cancellation punch-return works unchanged. Result shape
changes from a single `bookingId`/`barcodeToken` to a `bookings` array.

**API** (`apps/api/src/routes/rounds-booking.ts`): `book-punch` schema gains
`count` (1..12), drops `ticketType` — the route hardcodes `child_over_walking`.
The DB layer keeps `ticketType` in its input so staff tooling can still book a
baby entry if that ever matters. Waitlist join `ticketType` becomes optional with
the same default. Old clients still sending `ticketType` are unaffected (zod
strips unknown keys).

**UI** (`apps/customer/src/customer/CustomerApp.tsx`): `PunchRoundBooking` takes a
single `card` prop and renders inside that card in the "כרטיסיות פעילות" section;
the standalone button, the card-picker dropdown, and the baby/child toggle all go
away. A stepper in the confirm step picks the punch count, capped at
`min(entries left on card, seats left in round)`. Confirm copy pluralizes.

**Companion upsell**: the paid-extra-companion checkbox stays for count = 1 only —
the checkout attaches to a single booking. For count > 1 each entry already
includes one companion; a further extra companion is an in-person purchase (₪12 at
the door). Acceptable v1 tradeoff, revisit if Yanay hits it.

## Rejected alternatives

- Booking N entries as N client-side API calls: non-atomic — a partial failure
  strands the customer with some punches spent and no clear state. One
  transaction server-side or nothing.
- One booking row with a `quantity` column: breaks the one-child-one-companion
  invariant that the door scan, roster, and cancellation flows all assume.
- Keeping the baby/child toggle as a small checkbox: Yanay explicitly called the
  distinction confusing, and in this flow it is data-only (no price, no capacity
  effect). Paid WC bookings keep the real distinction (different products/prices).

## Security

No new surface. Card ownership, activity, and expiry checks unchanged and still
enforced inside the transaction with row locks. `count` is server-clamped by both
the capacity and card checks regardless of what the client sends; zod bounds it
1..12 (max card size) to reject nonsense early.

## Observability

- Client: `console.info('[customer punch-booking] …', { roundInstanceId, count, addCompanion })`
  at submit; existing `[customer companion]` checkout logs stay.
- Server: existing `request.log.info('[rounds book-punch] done')` gains
  `count` and the list of booking ids.

## Settings

Nothing exposed. Punch-count cap is derived (card entries / round seats), not a
knob. The baby/child removal is a product decision by the owner, not a setting.

## Testing

`packages/db/src/rounds-punch.test.ts`:
- count=3 books 3, card used+3, three punch entries each keyed to its booking.
- count > seats left → `round_full`, nothing punched.
- count > entries left (but > 0 left) → `not_enough_entries`, nothing punched.
- cancelling one of the three returns exactly one punch (guards the invariant the
  cancellation flow relies on).
- Existing single-booking tests updated to the new result shape.
Route tests in `apps/api` updated for the schema change. Run the affected
packages' suites (`packages/db`, `apps/api`). Known baseline: admin
`staff.test.ts` fails pre-existing (png import under node --test) — not a gate.

## Deploy

Normal flow: feature branch → PR → review → merge to `main` (production tracks
`main`; no direct pushes). API and customer app deploy together; the API change
is backward-compatible with the old client during rollout.
