# Cards list endpoint + admin Cards view wiring

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md`
Predecessor: `_plans/2026-06-18-admin-area-wiring.md`

Closes the last mock view in admin. Adds `GET /cards?status=...` on the backend, a thin client, and rewires the admin Cards view to use it.

---

## 1. Goals

- Admin can see a list of every punch card in the system, filterable by status (active / expired / cancelled).
- Each row shows: serial number, customer name + number + phone, usage (used/total), expiry date, and a status badge. Cancelled rows show the cancel reason.
- Tab switching between filters refetches; no hidden client-side filtering of a stale full list.

Success looks like: log in as admin → tap "ניהול כרטיסיות" → see real rows of active cards with the customer name attached. Switch to "שפגו" → see the expired/exhausted ones. Switch to "בוטלו" → see the cancelled ones with reasons.

## 2. Locked decisions

### 2.1 Three buckets, mutually exclusive

- **active**: `is_active = true`. By construction also implies not cancelled, not expired, and has entries remaining (the punch logic flips is_active when any of those become true).
- **cancelled**: `cancelled_at IS NOT NULL`. Always `is_active = false`.
- **expired**: `is_active = false` AND `cancelled_at IS NULL`. Catches expiry-by-time and exhaustion (12/12).

No "exhausted" bucket. Exhausted cards fall under "expired" in the UI sense because operationally a customer who used all entries needs a new card same as one whose card timed out.

### 2.2 Customer-joined response, not card-only

The endpoint returns each card joined with `firstName`, `lastName`, `customerNumber`, `phone` from the customers table. Reason: an unjoined list of serials is useless for the admin's "I want to see all cards" use case — they always need the human.

LEFT JOIN even though `customer_id` is NOT NULL, because future schema changes shouldn't break the list query.

### 2.3 Server-side cap at 200 rows, default 100

The brief mentions hundreds of customers, low-thousands of cards lifetime. 100 rows fits one screen-and-some. Hard cap of 200 protects against accidental no-filter blast.

No pagination in this chunk — the cap is sufficient for Phase 1. Pagination becomes meaningful when we have years of data; punt to a follow-up.

### 2.4 No "create card manually" affordance in this view (yet)

The previous mock had a "יצירת כרטיסייה ידנית" button. Removing it because:

- Sell flow on POS already covers creating a card for any customer (from customer detail or new-customer flow).
- Manual creation in admin would need a customer-picker, which is its own UX surface.

If Yanai wants it as a dedicated admin shortcut later, it's a one-screen add.

### 2.5 Status badge colors mirror the existing brand

- active: muted green (`#f0f5e3` bg, `#6f8f37` text) — matches existing "פעילה" badge.
- expired: muted grey (`#ececec`, `#9aa3a6`).
- cancelled: muted red (`#fbecec`, `#c25a5a`).

Cancel reason renders as a small italic line below the row's main content when present.

## 3. Files this chunk produces or modifies

```
packages/db/src/cards.ts                # add listCards(db, { status, limit })
packages/db/src/cards.test.ts           # +3 tests (one per status)
apps/api/src/routes/cards.ts            # add GET /cards?status=...
apps/api/src/app.test.ts                # add 401-without-auth test
apps/web/src/lib/api/cards.ts           # add listCardsForAdmin(status?)
apps/web/src/lib/api/cards.test.ts      # +1 test for the new client
apps/web/src/admin/AdminApp.tsx         # rewrite Cards view to use real list
apps/web/package.json                   # no change (test files already registered)
```

No new dependencies.

## 4. Build sequence

1. `listCards` in @memesh/db + tests against PGlite.
2. `GET /cards?status=...` endpoint (admin/manager only) + auth test.
3. Web client `listCardsForAdmin` + test.
4. Admin Cards view rewrite.
5. Verify: typecheck, tests (web/api/db), build, format. Manual smoke against the live API.

## 5. Security (rule 13)

- The endpoint is gated by `requireRoleHook('admin', 'manager')`. Cashiers cannot list all cards (only see them via the customer detail view, which is per-customer).
- Status enum is a Zod literal set — no SQL injection vector.
- Limit clamped at 200 server-side; a hostile `?limit=99999` gets rejected with 400.
- Response includes customer name + phone, which is PII; the role gate is the trust boundary.

## 6. Observability (rule 14)

- `[web admin cards] fetch` on view-mount + filter change.
- Server already logs route requests; nothing new.

## 7. Testing (rule 18)

- `cards.test.ts` in packages/db: seed N cards across the three states, verify each filter returns the right subset, default returns all.
- `cards.test.ts` in apps/web: stub fetch, assert URL contains `?status=active`, unwraps the `cards` array.
- `app.test.ts` in apps/api: GET /cards without auth returns 401 (matches the existing pattern for the other admin routes).
- Existing 108 tests stay green; expect ~113 after.

## 8. Settings (rule 15)

- No new user-facing settings. The default filter (active) is a sensible default; the three filter buttons are the UI's natural settings.
- Future: if the admin frequently wants "all" or "today only", those become quick-filter chips.

## 9. Yanai blockers

None.

## 10. Out of scope (deferred)

- Pagination beyond 200 rows.
- Per-card detail drill-down from the list (clicking a row could open the card's full info + history; today the cashier sees that via the customer detail view).
- Bulk operations (cancel many, extend expiry on many).
- Cancel-from-admin (today cancel is only callable via POST /cards/:id/cancel from POS — admin needs it too eventually).
- Search by serial / customer name (the customer search already covers the second; serial search would be its own affordance).

## 11. Alternatives rejected

- **Client-side filtering of a single fetch.** Looks fine at 100 rows; falls apart at the inflection point where pagination matters. Server-side filtering is the same complexity now and scales.
- **One bucket for "inactive" lumping expired + cancelled.** Operationally distinct: cancelled has a reason and a who; expired is a passive lifecycle event. Worth distinguishing in the UI.
- **Add cancel-from-admin in this chunk.** Doable but mixes read + write. Read first; write follow-up.

## 12. Open questions

None blocking.
