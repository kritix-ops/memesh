# Staff anonymous cash walk-in

Date: 2026-07-13
Branch: feat/admin-remove-from-round-any-date (feature can land here or on its own branch)
Requested by: Yanay (via Yoav). "Here there should also be an option to take cash
without collecting info from the customer — a quick add." Reply in thread: "that's in staff."

## Goal

On the staff rounds screen, let a cashier drop a head onto a round without typing a
name or phone. One tap. The child counts toward capacity and the safety headcount;
nothing about the person is collected.

## The reframe that sizes this

A manual walk-in today records **zero money** — the booking (`rounds-walkin.ts`) has no
price, no order, no card. It only puts a child on the round. So "take cash" is not a
request to record a payment. The cash is handled off-system, in the drawer. The only new
thing is **skipping the customer step**. This keeps the change small.

## The one hard constraint

`bookings.customer_id` is `NOT NULL REFERENCES customers(id)` (0015_rounds.sql), and
`customers.phone` is `NOT NULL UNIQUE`. The walk-in helper comment states the intent
explicitly: the customer link exists "so it shows in their history and at the door
(no anonymous bookings)." We are consciously carving out one exception.

## Decisions locked with Yoav (2026-07-13)

1. Cash: **just add the head** — no money recorded (matches today's manual walk-in).
2. Identity: **generic label + booking number** — every entry reads "כניסה במקום · R-####".
   No optional free-text field.

## Chosen approach: single sentinel customer (Option A)

One reserved system customer that all anonymous walk-ins book under.

- Reserved row: firstName "כניסה", lastName "במקום", phone `__walkin__`,
  customerNumber `L-0000` (the L-NNNN sequence starts at 1, so 0000 never collides).
- Resolve-or-create lazily server-side (`getOrCreateWalkInCustomerId`) — no data
  migration, self-healing across environments, race-safe via `onConflictDoNothing`.
- The walk-in booking reuses the existing `addWalkInBooking` path unchanged: same
  over-capacity gate, same `source='manual'` badge, same staff-action audit row
  (logs "הוספה ידנית לסבב · כניסה במקום · ..." with staffId).

### Alternatives rejected

- **B — nullable customer_id + display label.** Cleanest data model, but `customer_id`
  is load-bearing across attendees, check-in, reports, move/cancel/refund, reminders.
  Every join needs a null branch; one miss crashes at the door. Too much blast radius
  for one button.
- **C — throwaway customer per entry.** Pollutes the customers table with one junk row
  per cash entry, forever, each with a synthetic unique phone. Worst long-term.

## Where the sentinel must NOT leak (verified touch list)

Required:
- `rounds-reminders.ts` recipients (line ~94): an anonymous booking is `confirmed`, so
  it would be handed to the SMS cron with phone `__walkin__`. **Exclude the sentinel.**
- `rounds.ts` `listRoundAttendees` (line ~559): return an `anonymous` flag; the staff UI
  hides the phone/email line for it (name "כניסה במקום" + booking number identify it).
- `customer-directory.ts` `listCustomers`: exclude the sentinel from the directory +
  search (also stops it appearing in the walk-in search box).
- `reports.ts` `customersReport`: exclude the sentinel from the customers report.

Left as-is (correct behavior — an anonymous walk-in IS a real booking):
- `reports.ts` TicketsReport (bookings report): showing the walk-in is right; the
  `__walkin__` marker even signals "anonymous" to the admin.
- `rounds-arrival.ts` check-in lookup: showing "כניסה במקום" at the door is correct.

Not affected: all `punch_cards`-based joins (sentinel has no cards), auth/OTP/WC lookups
(nobody authenticates as phone `__walkin__`), waitlist (its own customer_id; anonymous
walk-ins never join a waitlist).

## Files to change

- `packages/db/src/walkin-customer.ts` (new): sentinel constants + `getOrCreateWalkInCustomerId`.
- `packages/db/src/index.ts`: export the new module.
- `packages/db/src/rounds.ts`: `listRoundAttendees` returns `anonymous`.
- `packages/db/src/rounds-reminders.ts`: exclude sentinel from recipients.
- `packages/db/src/customer-directory.ts`: exclude sentinel.
- `packages/db/src/reports.ts`: `customersReport` exclude sentinel.
- `apps/api/src/routes/staff-rounds.ts`: walk-in endpoint accepts `anonymous`, resolves sentinel.
- `apps/staff/src/lib/api/rounds.ts`: `addWalkIn` accepts `{ anonymous }`; `RoundAttendee.anonymous`.
- `apps/staff/src/RoundsView.tsx`: prominent "כניסה במקום · מזומן" button; hide phone/email for anonymous rows.
- Tests: sentinel get-or-create idempotency; reminders exclusion; directory exclusion.

## UX (lazy-user pass)

In the "+ הוספת משתתף" panel, the fast cash path is the first and biggest control:
a full-width accent button "כניסה במקום · מזומן — הוספה מהירה ללא פרטים". Search for an
existing customer sits below it; "לקוח חדש" stays as the toggle. One tap adds the head;
over-capacity is allowed when the venue setting allows it, and the success flash reads
"כניסה במקום נוספה לסבב" (with "· מעל התפוסה" when relevant).

## Security / safety (rule 13)

- **Shrinkage / audit.** A one-tap "add head, collect nothing" is a theft surface: staff
  could add entries and pocket cash with no per-entry money record to reconcile against.
  This risk already exists for today's manual walk-in. What we keep is the who/when/which-
  round staff-action audit row. What we cannot have, by the definition of "collect no
  info," is money reconciliation. This is a management-process control (periodically:
  count of anonymous walk-ins × price vs. drawer), flagged to Yoav and accepted knowingly.
- **PII:** anonymous means less PII, not more. The sentinel carries no real contact data.
- **Messaging:** the sentinel is excluded from reminder recipients, so the cron never
  tries to SMS `__walkin__`. It has no email and no login path.
- **Access control:** unchanged — same staff roles as the existing walk-in.
- **Cost:** none. One DB insert, no third party.

## Open questions

- None blocking. If reconciliation of anonymous cash becomes a need later, that is a
  separate, larger feature (per-entry price + a cash-drawer/POS concept).
