# Staff customer directory — browse, filter, sort (Yanay request, 2026-07-04)

## Goal

Yanay asked (WhatsApp): in the staff customer search, let the cashier see ALL
customers without typing anything — like a contacts list — sorted
alphabetically or by purchase date, with filters. Yoav added: filtering and
sorting must be robust, and if the full list gets heavy, lazy-load it.

## Requirements

- Opening "חיפוש לקוח" with an empty query shows the full customer directory,
  not a blank screen.
- Sorting: alphabetical (א-ב), newest registered, last card purchase.
- Filters: status (הכל / VIP / מוקפאים) and "has an active card". Filters,
  sort, and free-text search all compose — typing a query searches WITHIN the
  chosen filters and sort.
- Pagination: pages of 30, auto-loaded as the cashier scrolls (sentinel +
  IntersectionObserver), with a total count shown so the list never feels
  truncated. This answers the "too much loading" concern up front.
- Admin app keeps working unchanged (it calls the same GET /customers).

## Approach (chosen)

One endpoint, one query surface. Extend GET /customers with `sort`, `order`
(implied by sort), `status`, `hasActiveCard`, `limit`, `offset`. Response
gains `total` and per-row `lastPurchaseAt` (max punch_cards.created_at per
customer) — both additive, so the admin tab's existing `results` consumption
is untouched. When no new params are sent, defaults reproduce today's exact
behavior (empty q → 50 newest; with q → top 20 by createdAt desc).

Query logic lives in a new `packages/db/src/customer-directory.ts`
(`listCustomers`), not inline in the route, because "data-level assertions
live with the DB helpers" (staff-rounds test header) — PGlite tests can pin
sorting/filtering semantics there. lastPurchase sort uses a LEFT JOIN on a
grouped punch_cards subquery, NULLS LAST so customers who never bought sink
to the bottom instead of disappearing.

## Alternatives rejected

- **Client-side everything (fetch all, filter/sort in React):** simplest, and
  fine at hundreds of customers, but directly contradicts the lazy-loading
  requirement and gets worse forever. Rejected.
- **Separate /customers/directory endpoint:** keeps the legacy endpoint
  frozen, but duplicates the search logic and splits "search" from "browse"
  when Yanay explicitly wants them to be the same surface. Rejected.
- **Cursor pagination instead of offset:** more correct under concurrent
  inserts, but at this scale (thousands of customers, single-branch business)
  offset is simpler and the failure mode (a row shifting one page) is
  harmless here. Rejected for now; the API shape doesn't preclude it later.

## UI (staff PosApp, Search screen)

- Search input unchanged on top.
- Below it: sort chips (א-ב / חדשים / רכישה אחרונה) and filter chips
  (הכל / VIP / מוקפאים / עם כרטיסייה פעילה). Chips, not dropdowns — one tap,
  visible state, lazy-user friendly.
- Result rows unchanged (avatar, name, phone · number); when sorting by last
  purchase, the row also shows the last purchase date (or "ללא רכישות").
- Count line "N לקוחות" above the list; sentinel row at the bottom
  auto-loads the next page.
- Default sort: א-ב (what Yanay described — a contacts list).

## Security

No new surface: same requireRoleHook(cashier/manager/admin) guard, all new
params validated with zod (enum sort/status, bounded limit/offset), no new
data exposed that staff can't already see via search.

## Observability

- Client: `console.info('[pos directory] fire', { q, sort, status, hasActiveCard, offset })`
  and `[pos directory] page loaded` with counts.
- Server: `request.log.info` on the list query with parsed params + result
  count (the route previously logged nothing on GET; browse queries are worth
  one line).

## Settings audit

Default sort and page size are deliberate constants, not settings — a cashier
station should behave identically at every till, and the admin has no reason
to configure page size. Nothing exposed.

## Testing

- `packages/db/src/customer-directory.test.ts` (PGlite): sorts (name,
  newest, lastPurchase incl. NULLS LAST), filters (status, hasActiveCard),
  q composition, pagination (limit/offset/total), legacy defaults.
- `apps/api/src/routes/customers.test.ts`: 401 unauthenticated, 400 invalid
  params, 200-or-500 passthrough pattern (matches staff-rounds.test.ts).
- `apps/staff/src/lib/api/customers.test.ts`: new params serialize correctly,
  old call shape still works.
- Known baseline: admin staff.test.ts fails pre-existing (.png import) — not
  a regression gate.

## Deploy

Branch feat/staff-rounds-date-nav is current; this work goes on a new branch
off it (or the same branch if Yoav prefers), PR into main as usual. No schema
migration needed — read-only query changes only.
