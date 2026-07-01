# Punch-card round booking (כרטיסייה → סבב)

Date: 2026-07-01
Spec: super-brief §3.4 (the hold flow works for punch cards; step 4 is a punch instead of a WC payment).

## Goal
A customer with a כרטיסייה (prepaid 12-entry punch card) can book a seat in a round from the personal area, paying with one punch instead of going through WooCommerce. On cancellation the punch is returned, not money.

## Why this is our-side only
No money moves. The customer already paid when they bought the card. Booking a round just spends one of their entries. WooCommerce is not involved.

## Decisions (defaults chosen, per "yes do it all")
- A customer may only spend punches from a card they own (owner check on `punch_cards.customer_id`).
- A clear confirm step before punching ("this uses 1 of your N entries").
- One punch = one child entry, regardless of baby/child ticket type (both draw one pool seat; the base entry card already includes one accompanying adult). Additional paid companions are NOT offered on the punch path (that would need a mixed punch+cash cart, out of scope).
- The punch happens at booking time (spec §3.4), not at the door. The door later scans the round barcode and burns it to `used`; the punch was already spent.

## Money-safety / correctness
- `bookRoundWithPunch` is one transaction: lock the round instance and check capacity (same oversell guard as `createHold`), lock the card and validate (owner, active, not expired, has a remaining entry), insert the booking as `confirmed` with `source='punchcard'` + `punch_card_id`, write a `punch_card_entries` row (decrement), sign the barcode. All-or-nothing, so no free booking and no spent punch without a booking.
- The door same-day lockout in `punchCard()` is a door concept and would wrongly block advance bookings, so the punch is written inline here (no lockout), method `online`, `punched_by = null`, `idempotency_key = bookingId` (the link cancellation uses to find and reverse the entry).
- Cancellation (`cancelBooking`, extended): for `source='punchcard'`, reverse the linked entry (restore `used_entries`, reactivate the card if exhaustion had deactivated it) instead of a WC refund. Same 24h window gate.

## Files
- schema: add `online` to `punch_method` enum (+ migration 0020, + PunchMethod type, + report filter unions for consistency).
- `packages/db/src/rounds-punch.ts` (new): `bookRoundWithPunch`.
- `packages/db/src/rounds-cancel.ts`: punch-return branch.
- `apps/api/src/routes/rounds-booking.ts`: `POST /rounds/book-punch` (customer-gated, owner-checked); cancel response gains `punchReturned`.
- `apps/customer`: a "book a round with your כרטיסייה" flow (date → availability → pick round → confirm → uses one entry), plus punch-return messaging on cancel.

## Security
- Customer-gated endpoint; the card owner check is in the DB helper (never trust the client's punchCardId alone).
- Barcode is HMAC-signed exactly like paid bookings; no forging from the client.
- Capacity guard is the same row-locked check as the paid path (no oversell).

## Out of scope (noted)
- Mixed punch + paid companion in one booking.
- Punch-card purchase itself (already exists via WC).
- Waitlist promotion on a freed seat.
