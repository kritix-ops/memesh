# Reports overhaul + cards-management search

**Status:** approved 2026-06-20 (Yoav: "I trust you to think of the best practices").

## Goal

Replace the thin two-card דוחות screen with a real reporting surface:
sub-navigation across 5 distinct reports, rich filters per report,
sortable result tables, CSV export, browser-print → "Save as PDF",
and a smooth search bar inside ניהול כרטיסיות.

## Locked decisions (my calls, documented)

| Decision | Choice | Why |
|---|---|---|
| PDF | `window.print()` + print stylesheet | Server PDF needs Puppeteer/Chromium (~150MB) which doesn't fit in Vercel's 250MB function. Print-to-PDF is universal. |
| CSV | Client-side blob download | Zero backend cost, instant. |
| Custom reports | 5 pre-built reports with rich filters | A full ad-hoc query builder is months of work for marginal gain. |
| Revenue | Estimated = `current price × count`, with caveat | Price-at-sale not stored on cards today. Future migration could fix. |
| Cards search field | Serial + customer name + phone + number | One text box, smart match across all four. |

## Sections (5 reports + cards-search)

### 1. סקירה (Overview)
Re-home of today's dashboard stats + dormant customers + recent action log.
No new logic, just relocated under the new sub-nav so it's discoverable.

### 2. לקוחות (Customers)
- Filters: registered between (from/to dates), source, marketing consent,
  has-active-card (yes/no/either), dormant ≥ N days.
- Columns: number, name, phone, email, registered date, last visit, active cards.
- Sort: any column.
- Export: CSV + Print.

### 3. כרטיסיות (Cards)
- Filters: status (active/expired/cancelled), source (pos/online/manual),
  sold between, expires within N days, usage range (used/total %).
- Columns: serial, customer, used/total, expiry, source, sold-on.
- Sort: any column.
- Export: CSV + Print.

### 4. כניסות (Entries)
- Filters: date range, customer, card serial, method (qr/serial),
  refunded (yes/no/either), staff who punched, companion count.
- Columns: date+time, customer, card serial, companions, method, staff, refunded.
- Sort: by date (default desc).
- Pagination: load-more, 50 rows per page.
- Export: CSV + Print.

### 5. הכנסות (Revenue) — with caveat
- Filters: date range, group-by (day/week/month).
- Columns: period bucket, cards sold, estimated revenue.
- Caveat shown: "מחיר מחושב לפי הגדרה נוכחית (₪320) × כרטיסיות שנמכרו.
  לחישוב מדויק יידרש לאחסן את המחיר בעת המכירה — להמשך."
- Export: CSV + Print.

### Cards-management search
- New `q` query param on the existing `GET /cards` endpoint.
- Searches case-insensitively across serial, customer first/last name,
  phone, customer number.
- Frontend: debounced text input above the existing status filter.

## Backend

### db

1. **Extend `listCards`** in `packages/db/src/cards.ts` to accept `q?: string`.
   Builds an `OR` across `ilike` on `punch_cards.serial_number` and joined
   `customers.first_name / last_name / phone / customer_number`.

2. **New `customersReport(db, filters)`** in `packages/db/src/reports.ts`:
   - `registeredFrom`, `registeredTo` (timestamps)
   - `source` enum
   - `marketingConsent` boolean (true = consented, false = not)
   - `hasActiveCard` boolean
   - `dormantSinceDays` number — last visit older than N days, or never
   - Joins for active-card count + last-visit max.

3. **New `cardsReport(db, filters)`** — extends listCards with:
   - `soldFrom`, `soldTo`
   - `expiringWithinDays`
   - `usageMin`, `usageMax` (percentage)
   - `source`

4. **New `entriesReport(db, filters)`**:
   - `from`, `to` timestamps
   - `customerId`, `cardSerial`
   - `method` enum
   - `refunded` boolean / null = either
   - `punchedBy` staff id
   - `limit` + `offset` for pagination
   - Returns rows + total count.

5. **New `revenueReport(db, { from, to, groupBy })`**:
   - Sums cards sold per period bucket.
   - Reads current price from settings, multiplies.
   - Returns `[{ period: 'YYYY-MM', cardsSold, estimatedRevenue }, ...]`.

### API routes

All admin or manager. New file `apps/api/src/routes/reports.ts`:
- `GET /admin/reports/customers?...`
- `GET /admin/reports/cards?...`
- `GET /admin/reports/entries?...`
- `GET /admin/reports/revenue?...`

Existing `GET /cards` extended with `?q=...`.

### Tests

- listCards filtered by q across serial + customer name.
- customersReport with date range + source + marketing consent.
- cardsReport with usage range.
- entriesReport with date range + pagination + refunded filter.
- revenueReport bucketed by month.

## Frontend

### Utilities (new files)

- `apps/web/src/lib/csv.ts` — `toCsv(rows, headers)` + `downloadCsv(filename, csv)`.
- `apps/web/src/lib/print.ts` — `printReport(title)` triggers `window.print()`
  with a temporary `data-print-title` attr the stylesheet reads.

### Print stylesheet

Add `@media print { ... }` to `apps/web/src/index.css`:
- Hide top nav, sub-nav, action buttons.
- Show only `.report-printable` content.
- Page-break-friendly: `tr { page-break-inside: avoid }`, headers repeat.
- Add header with report title + date printed.

### Reports.tsx

Replace today's inline Reports in `AdminApp.tsx` with a new
`apps/web/src/admin/reports/Reports.tsx`. Sub-nav layout:

```
┌─────────────────────────────────────────────┐
│  דוחות                                       │
├─────────────┬───────────────────────────────┤
│ סקירה       │  [active section]              │
│ לקוחות      │  [filters bar]                 │
│ כרטיסיות    │  [results table]               │
│ כניסות      │  [export CSV] [הדפסה / PDF]    │
│ הכנסות      │                                │
└─────────────┴───────────────────────────────┘
```

Each report is its own file in `apps/web/src/admin/reports/`:
- `OverviewReport.tsx` (today's content)
- `CustomersReport.tsx`
- `CardsReport.tsx`
- `EntriesReport.tsx`
- `RevenueReport.tsx`
- `shared.tsx` (Filter bar, Table, ExportBar, common styles)

### Cards search

In `Cards()` in `AdminApp.tsx`, add a search input above the status filter
chips. Debounce 300ms, pass `q` to `listCardsForAdmin`.

## Observability

- `[web reports] view {section}` on tab change.
- `[web reports] export csv/print {section, rowCount}` on action.
- `[reports.customers]`, `[reports.cards]`, etc. server-side info log per call.

## Security

- All report endpoints `requireRoleHook('admin', 'manager')`.
- CSV export happens client-side over already-authenticated data.
- Print is local to the browser; no server involvement.

## Out of scope

- Server-side PDF (Puppeteer/Chromium).
- SQL query builder.
- True revenue tracking (needs price-at-sale column).
- Scheduled reports / email delivery (needs cron infra).
- Cross-account reports (multi-tenant).
