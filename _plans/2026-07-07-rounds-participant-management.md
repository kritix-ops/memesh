# Rounds participant management + closures accordion + upcoming-entry indicator

Date: 2026-07-07
Branch base: `feat/multi-child-booking` (current) — new work on a fresh branch off `main` per deploy rules.
Origin: Yanay/Yoav product feedback (rapid-fire, one session). Council skipped per standing note on Yanay-originated asks.

## The five asks (verbatim intent)

1. **Closures accordion** — the admin "מתי הסבבים פועלים" list scrolls forever (one row per Shabbat/holiday from the holiday sync). Make it a collapsible accordion.
2. **Remove someone from a סבב (admin)** — admin can remove a participant from a round; if the booking was paid by a כרטיסיה, the punch entry is returned to the customer.
3. **Upcoming-entry indicator (everywhere + door warning)** — when a customer has reserved a future round, surface it clearly in customer, admin, and staff views, and warn the cashier when punching a card that has an upcoming reserved round.
4. **Move a booking earlier (staff + admin)** — someone booked 14:00 but shows up at 08:00; staff/admin can move that booking to a different (earlier) round the same day.
5. **Over-capacity walk-in (staff + admin)** — even when a round is full, staff/admin can still add a participant; walk-ins are marked separately from registered bookings.

## Decisions locked with Yoav (2026-07-07)

- **Paid removal (ask 2):** auto-refund via WooCommerce, fail-closed — mirror the customer cancel flow; release the seat only after the refund confirms.
- **Remove UI placement:** expand a round tile on the admin live dashboard into an attendee list with the actions.
- **Indicator scope:** all three views + an active door warning when punching a card with an upcoming reservation.

## Key grounding facts (why this is smaller than it looks)

- `cancelBooking` (`packages/db/src/rounds-cancel.ts`) **already** returns the punch entry, restores `usedEntries`, and reactivates an exhausted card. It is customer-scoped (ownership check + 24h `too_late` window). Ask 2 = an admin-actor variant of it.
- `swapBooking` (`packages/db/src/rounds-swap.ts`) **already** moves a booking atomically without oversell and re-mints the barcode. Customer-scoped (ownership + "before original round starts"). Ask 4 = a staff/admin-actor variant.
- A punch-card round booking **already deducts the entry at booking time** (`bookRoundWithPunch` increments `usedEntries` immediately). So ask 3 is **not** an accounting fix — the reserved entry cannot be double-spent at the door. It is a transparency/warning feature. This is the single most important correction to the premise.
- `bookings.source` enum already has `'manual'`. Ask 5 = a manual/walk-in insert that is allowed to exceed `capacity` and is counted separately.
- Staff already has a per-round attendee list (`GET /staff/rounds/:id/attendees`, `listRoundAttendees`) and manual arrival (`setBookingArrival`). The admin app has none — only occupancy counts.
- `roundScheduleRules` has **no** origin/source column distinguishing holiday-synced rows from manual ones. The accordion groups heuristically (single-date + `outside=closed` + no windows = a "closure"; everything else = an active rule).

## Security (rule 13)

- Every new endpoint is role-gated with the existing `requireRoleHook`. Remove/refund = **admin only** (money authority). Move + walk-in add = **cashier/manager/admin** (floor operations). Indicator reads = same trust level as existing attendee reads.
- Refund path stays **fail-closed**: no seat released / no cancel committed unless the WC refund confirms. Reuse the exact `refund` dep pattern from `rounds-booking.ts`.
- Walk-in add is capacity-bypassing by design; guard against abuse by (a) admin/staff gate, (b) logging every override via `logStaffAction`, (c) capping a single over-capacity add per request (no bulk). No customer-supplied capacity or price fields trusted.
- Actor-override variants must **not** be reachable from the customer routes — new endpoints live under `/admin/*` and `/staff/*` only; the customer `/rounds/cancel` and `/rounds/swap` keep their ownership checks unchanged.
- Every mutating action writes a staff-action audit row (who removed/moved/added whom, and why) so an over-capacity or refund decision is traceable.

## Observability (rule 14)

Namespaced logs at every step, values not just events:
- `[admin rounds remove] { bookingId, actorId, source, refunded, punchReturned, refundAmountIls }`
- `[rounds move] { bookingId, actorId, from, to, force }`
- `[rounds walkin] { roundInstanceId, actorId, customerId, overCapacity, taken, capacity }`
- `[rounds upcoming] { customerId, count }` and `[punch door warning] { cardId, upcomingReserved }`
- Frontend `console.info('[admin dashboard attendees] …', {...})` on expand/remove/move/add.

## Testing (rule 18)

- DB helpers (`packages/db`): unit tests per new function — admin cancel (paid refund confirmed / refund fails → seat kept / punch returned / not-found / already-cancelled), staff swap (moves, target full without force, forbidden bypass works for staff, timing), walk-in add (over-capacity allowed, marked manual, counted separately, requires a customer), upcoming-reservations query. Mirror the existing `rounds-cancel.test.ts` / `rounds-swap.test.ts` style. A refund-fails test must fail on a naive implementation and pass on the fail-closed one.
- Route tests (`apps/api`): role gating (customer token rejected on admin/staff endpoints), happy path, error codes.
- Frontend logic: pure grouping helper for the accordion gets a unit test; component behavior kept thin.
- Full `pnpm -r test` before calling done. Known-baseline: `apps/staff` `staff.test.ts` .png import failure is pre-existing, not a regression.

## Settings audit (rule 15)

- **Walk-in / over-capacity add:** expose a toggle "אפשר הוספה ידנית מעל התפוסה" (default on) under round settings, so the venue can disable over-capacity adds. Without it, capacity bypass is hardcoded — a choice the venue can never undo.
- **Door warning for upcoming reservations:** a toggle "התראה בקופה כשיש הזמנה עתידית" (default on).
- Not exposed (and why): the 24h cancel-window override for admins is inherent to the admin role, not a per-venue knob.

## Deploy (rule 19)

- New branch off `main` (e.g. `feat/rounds-participant-management`). `main` is production-tracking — never pushed/promoted by hand. PR → CI → merge.
- `apps/admin` and `apps/api` deploy as **separate** projects; ship API (new endpoints) before the admin UI that calls them, and keep the admin resilient to an older API (feature-detect new fields). Same discipline the codebase already documents.
- DB change: only if ask 5 needs a column (see open question O2). A migration is additive (nullable/defaulted) and deploys with the API.

## Build order (phased, each independently shippable)

- **Phase 1 — Closures accordion (ask 1).** Frontend only in `Rounds.tsx` `ScheduleRulesManager`. Group rules: active/manual rules always visible; pure closures collapsed by default under "ימי סגירה (חגים ושבתות)", grouped by month with a count. Pure logic helper + test. Lowest risk, ship first.
- **Phase 2 — Backend engine.** DB helpers + API routes + tests for: admin remove (2), staff/admin move (4), walk-in add (5), upcoming-reservations read (3). No UI yet.
- **Phase 3 — Admin round panel.** Expand `RoundTile` on the live dashboard → attendee list (reuse `listRoundAttendees`) with remove / move / add-walk-in, walk-ins shown separately from registered.
- **Phase 4 — Staff floor.** Add move + walk-in add to the staff attendees screen; add the door punch warning.
- **Phase 5 — Indicator polish (3).** Upcoming-reservation badges in customer personal area, admin dashboard, and staff views.

## Open questions (O)

- **O1 (walk-in identity):** a manual walk-in still needs a `customer_id` (NOT NULL FK). Proposal: staff attaches the walk-in to a customer via the existing POS-style search / quick-add, same as the card flow — no anonymous bookings, so it shows in the customer's history and at the door. Confirm this vs. allowing a true anonymous placeholder.
- **O2 (walk-in marking):** `source='manual'` is the natural marker and needs no schema change, but a manual add is not necessarily over-capacity. If we need to distinguish "over-capacity override" specifically (e.g. red badge only when it pushed past capacity), that is derivable at read time (taken > capacity) without a new column. Proposal: no schema change; mark by `source='manual'` + derived over-capacity flag.
- **O3 (move target window):** allow moving to a round that already started earlier the same day (the 08:00 case)? Proposal: yes for staff/admin — the whole point is accommodating an early arrival; only block moving into a `closed` instance.
