# Admin tickets management (ניהול כרטיסים) + tickets report in דוחות

Date: 2026-07-09
Origin: Yoav — "now that we also have כרטיסים (entrance tickets, not כרטיסיות), add a
ניהול כרטיסים to the admin, robust like the other admin sections, plus a report in דוחות."
Branch: `feat/admin-tickets-management` off `origin/main`.

## What a "ticket" is here

A row in `bookings` (packages/db/src/schema/bookings.ts): a single entrance to a round
instance. Human number `R-YYYYMMDD-NNNN`, statuses `held | confirmed | used | cancelled |
expired`, sources `paid | punchcard | gift | manual`, optional punch-card link, optional
WC order, HMAC barcode. Punch cards (כרטיסיות) already have full management + reports;
tickets have only per-round views (admin live dashboard attendees panel, staff floor).
Nothing lists tickets across rounds, and דוחות has no tickets section.

## Goal

1. A cross-round ניהול כרטיסים view in the admin nav: search any ticket by number /
   customer, filter, see its full story, and act on it (move, remove, mark arrival).
2. A כרטיסים report in דוחות: date-range + filters, sortable table, summary tiles,
   CSV + print — same shape as the other five reports.

## Locked decisions (mine, documented)

| Decision | Choice | Why |
|---|---|---|
| One query, two surfaces | Single `ticketsReport` db fn + single `GET /admin/reports/tickets` endpoint feeds BOTH the management screen and the report | SSOT (rule 20). The two surfaces differ in actions, not in data. |
| `held` bookings | Excluded everywhere | Transient WC-checkout holds with a TTL; showing them invites acting on rows that vanish. |
| Actions | Reuse existing `/staff/rounds/bookings/:id/{cancel,move,arrival}` endpoints | They already exist, are role-gated, audited, and money-safe (fail-closed refund). Zero new mutation surface. |
| Move targets | Same-date rounds via existing public `GET /rounds/availability?date=` | The move rule (same day, capacity checks) already lives server-side in the move endpoint. |
| Summary counts | Per-status counts computed under all filters EXCEPT status | So the tiles/chips show the distribution of the filtered set instead of collapsing to one bucket. |
| No-shows | Derived, not stored: `confirmed` + round date before venue-today | No schema change; flagged visually in both surfaces. |
| Pagination | limit/offset + total, "load more" at 100/page | Mirrors entriesReport; bookings will outgrow a single fetch. |

## Backend

### packages/db/src/reports.ts — `ticketsReport(db, filters)`

Filters: `q` (booking number / customer first+last name / phone / customer number,
ilike OR), `status` (confirmed|used|cancelled|expired), `source`, `ticketType`,
`dateFrom` / `dateTo` (round-instance date, YYYY-MM-DD), `limit` (default 200, max
1000), `offset`, `sort` (`date` | `createdAt` | `bookingNumber`), `sortDir`.
Default order: round date desc, start time asc, created desc.

Row: bookingId, bookingNumber, customerId, customerNumber, firstName, lastName, phone,
roundInstanceId, date, roundLabel (displayName), startTime/endTime (HH:MM), ticketType,
additionalCompanions, source, status, punchCardSerial (left join on punchCardId),
wcOrderId, createdAt, usedAt.

Page: `{ rows, total, summary: { confirmed, used, cancelled, expired, companions } }`.
Joins: bookings → roundInstances → rounds, → customers, left → punchCards.

### apps/api/src/routes/reports.ts — `GET /admin/reports/tickets`

Zod query schema mirroring the filters (isoDate for dates, enums, coerced ints with
caps). `requireRoleHook('manager', 'admin')` like the other five. Log
`[reports.tickets]` with row/total counts.

## Frontend — management screen

- `AdminApp.tsx`: `View` union + NAV get `{ key: 'tickets', label: 'ניהול כרטיסים' }`
  right after ניהול כרטיסיות. Visible to managers (server enforces per-action gates).
- New `apps/admin/src/admin/Tickets.tsx` (own file — AdminApp.tsx is already big):
  - Debounced search (300ms): "מספר כרטיס, שם, טלפון או מספר לקוח…".
  - Status chips: פעילים (confirmed, default) / נוצלו / בוטלו / הכל; date-range preset
    field; source select.
  - Table: number, customer, phone, round date, round (label + times), type, companions,
    source badge, status badge (incl. derived no-show "לא הגיע/ה" on past confirmed).
  - Row expands inline (attendees-panel pattern) to: full timestamps (created / used),
    punch-card serial, WC order, gift recipient; and the actions:
    - העברה לסבב אחר — chips of same-date open rounds (availability fetch), staff move
      endpoint; venue-today bookings use the live-dashboard rounds list so already-started
      rounds stay valid targets (the 08:00 early-arrival case).
    - סימון הגעה / ביטול סימון — only when round date == venue today (server rule).
    - הסרה — admin-only button; inline confirm explaining the money path (WC refund /
      punch return), shows the result flash.
  - "טען עוד" pagination + total count; loading / empty / error states.
- New client `apps/admin/src/lib/api/tickets.ts`: `fetchTicketsReport(filters)`;
  `markTicketArrival(bookingId, arrived)` added to `round-participants.ts` (move/remove
  clients already exist there).

## Frontend — report

- `reports/Reports.tsx` SECTIONS: `{ key: 'tickets', label: 'כרטיסים' }` after כרטיסיות.
- New `reports/TicketsReport.tsx`: DateRangeField (round date), status/source/type
  selects, SearchInput, StatTiles (סה"כ, הגיעו, בוטלו, מלווים), sortable Table
  (date / createdAt / bookingNumber), load-more, ExportBar (CSV via toCsv/downloadCsv,
  print via printReport) — mirroring EntriesReport.

## Security (rule 13)

- Read endpoint gated `manager|admin`; customer/cashier tokens get 403 (route test pins it).
- All mutations go through the existing audited, role-gated staff endpoints — remove
  stays admin-only server-side; UI hiding is UX, not the gate.
- Query strictly Zod-validated; q capped at 120 chars; limit capped at 1000; ilike inputs
  parameterized by drizzle (no raw SQL).
- No new PII exposure beyond what the attendees panel already shows staff.

## Observability (rule 14)

- Server: `request.log.info({ rows, total }, '[reports.tickets]')`.
- Client: `[web tickets] load { filters, count, total }`, `[web tickets] move|remove|arrival
  submit/success/error { bookingId, … }`, `[web reports] view tickets`, export logs ride
  the existing ExportBar pattern.

## Settings audit (rule 15)

Nothing new exposed. Page size, default chip, and sort defaults are UI conventions
identical to the sibling sections (none of which expose knobs); a per-venue setting for
them has no operational meaning. The behaviors with real policy weight (over-capacity
walk-in, cancel window skip) already have their settings/roles from the participant-
management work.

## Testing (rule 18)

- `packages/db/src/tickets-report.test.ts` (PGlite, mirrors rounds-arrival.test.ts
  harness): seed rounds + customers + punch/paid bookings; assert q across number/name/
  phone, status + source + ticketType + date filters, pagination totals, summary counts
  ignore the status filter, punch serial join, sort orders, held rows never appear.
- `apps/api` reports route test: 401 no token, 403 cashier + customer token, 400 bad
  query, 200 happy shape.
- `apps/admin` client test: URL building for `fetchTicketsReport` (fetch stub, mirrors
  cards.test.ts style).
- Full suites for packages/db, apps/api, apps/admin before done. Known baseline:
  apps/staff staff.test.ts .png failure is pre-existing.

## Deploy (rule 19)

- Work on `feat/admin-tickets-management` off `origin/main` (this checkout currently sits
  on `feat/customer-area-redesign`, clean — switching is safe; untracked doc files stay).
- No DB migration (read-only feature over existing tables).
- PR → CI → merge to `main` (production-tracking; never pushed by hand). API and admin
  deploy from the same merge; the admin page fails soft (error state) if it ever meets an
  older API.

## Out of scope (documented)

- Filter by round template / specific round (add later if asked).
- Bulk actions (bulk cancel/move).
- QR re-send / SMS from this screen.
- Waitlist rows (separate table; separate surface if ever needed).
- Revenue attribution for paid tickets (belongs to the revenue report, needs
  price-at-sale storage — same caveat as cards revenue).
