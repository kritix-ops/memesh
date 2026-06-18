# Admin area wiring (dashboard + customers + staff + reports + action log)

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md` (handoff section, surface flips)
Predecessor: `_plans/2026-06-18-customer-area-wiring.md`

Flips the `ניהול` (admin) tab from mock to live: dashboard stats, customer search, staff list + create, dormant-customers report, and the staff action log. Closes the last of the three Phase 1 surfaces with one deliberate exception (the Cards list view stays mock — no backend list endpoint exists yet, and adding it is its own small focused chunk).

---

## 1. Goals

- **Dashboard** shows real numbers from `GET /admin/dashboard` (entries last 24h / 7d / 30d, cards sold last 30d, expiring in 30d, new customers last 7d). Action-log preview pulls `GET /admin/actions` (top 5).
- **Customers** view: search bar runs the same `GET /customers?q=...` we wired for POS, results render with the live shape (real customer numbers, real phones).
- **Cards** view stays mock and shows a small "תצוגה זמנית" note — backend has no list endpoint yet.
- **Staff** view lists members via `GET /staff`, with a create form that POSTs `/staff` and refetches on success. Phone-taken (409) is surfaced inline.
- **Reports** view: dormant customers from `GET /admin/reports/dormant`, plus the full action log from `GET /admin/actions` (50 rows).
- The decorative weekly + revenue bar charts stay as visualizations with a small "תצוגה זמנית" badge — the aggregate endpoint returns counts, not time series; real charts come with a future dashboard-timeseries endpoint.

Success looks like: log in as the seeded admin → tap "ניהול" → dashboard renders real numbers within a beat. Switch to "ניהול צוות" → see the seed admin plus any other staff that's been created. Submit a new staff member → row appears in the list. Switch to "דוחות" → see dormant customers and the full action log.

## 2. Locked decisions

### 2.1 Reuse the staff session — no new provider

Admin shares the staff session that already drives POS. Roles enforced server-side: dashboard/dormant/actions require `admin` or `manager`; staff create requires `admin`. The web client never gates by role — the API is the boundary, and if a manager tries to hit a staff-create surface the server 403s.

### 2.2 No new API endpoints in this chunk

Every view here uses an endpoint that already exists. The Cards list view, which would need a new endpoint (`GET /cards?status=...`), is left mock with an explicit "תצוגה זמנית" note. That chunk lands separately so this one stays reviewable.

### 2.3 Charts stay mock with a "תצוגה זמנית" badge

The dashboard's weekly bar chart and monthly revenue chart are decorative — they imply a daily/monthly time series we don't yet expose. The aggregate `/admin/dashboard` returns running totals, not series. Two paths:

- Leave the charts as-is with mock data and label them clearly.
- Build a `/admin/dashboard/timeseries?bucket=day&days=N` endpoint.

I'm going with option 1 for this chunk. The numbers BELOW the charts are real; the charts are visual context, not the data the owner makes decisions from. Real chart wiring is a small follow-up chunk.

### 2.4 Action log: one query, two surfaces

`GET /admin/actions` returns up to 50 rows. The Dashboard preview shows the top 5; the Reports view shows all 50. Both views use the same hook (one fetch, sliced two ways) so we don't double-roundtrip when the admin switches tabs.

### 2.5 Staff create form: in-line on the Staff view, not a modal

The existing UI has a "הוספת איש צוות" affordance. Keep it as an in-line section (or expandable card), not a modal. Why: the staff list is read-mostly; adding a member is rare; a modal-over-list is heavier UX than a small form at the top of the view.

Role default = `cashier`. Admin can pick admin/manager/cashier explicitly.

### 2.6 No "delete staff" / "deactivate staff" yet

Backend has `is_active` on the staff row but no API endpoint to flip it. Leaving the delete affordance off until the endpoint lands. Honest absence is better than a non-functional button.

## 3. Files this chunk produces or modifies

```
apps/web/src/lib/api/admin.ts                # new: getDashboardStats, getDormantCustomers, listStaffActions
apps/web/src/lib/api/admin.test.ts           # new
apps/web/src/lib/api/staff.ts                # new: listStaff, createStaff
apps/web/src/lib/api/staff.test.ts           # new
apps/web/src/admin/AdminApp.tsx              # rewrite the 5 sub-views (cards stays mock)
apps/web/package.json                        # register the 2 new test files
```

No backend changes.

## 4. Build sequence

1. `lib/api/admin.ts` + `lib/api/staff.ts` clients + tests.
2. AdminApp Dashboard: replace mock STATS + ACTION_LOG with live calls.
3. AdminApp Customers: replace static initialCustomers filter with `/customers?q=...`.
4. AdminApp Staff: list + create form + 409 phone-taken inline.
5. AdminApp Reports: dormant + full action log.
6. AdminApp Cards: keep mock, add a "תצוגה זמנית — תופעל אחרי חיבור endpoint ייעודי" note.
7. Verify: typecheck, tests, build, format. Manual smoke against the live API.

## 5. Security (rule 13)

- Server enforces role per endpoint (`requireRoleHook('admin', 'manager')` for read endpoints, `requireRoleHook('admin')` for staff-create). The client trusts the server.
- `listStaff` returns the safe view (no password hash). The admin UI never sees the hash.
- Staff create form: password input is `type="password"`, never logged. Min length 4 server-side; we hint 6+ in the UI for fewer rejections without weakening the server-side floor.
- Action log already excludes any PII other than staff names. Customer names in the log are the audit subject, which is the point of the log; no extra scrubbing.

## 6. Observability (rule 14)

- `[web admin dashboard]` on fetch start/done with `{ ok, stats: ... }`.
- `[web admin actions]` similar.
- `[web admin dormant]` similar.
- `[web staff list/create]` similar.
- Server side already logs `[staff] created`, `[admin actions]` etc.

## 7. Testing (rule 18)

- `admin.test.ts`: dashboard unwraps `stats`; dormant unwraps `customers`; actions unwraps `actions`.
- `staff.test.ts`: listStaff unwraps `staff`; createStaff body shape + 409 phone_taken error.
- Existing 102 tests stay green; expect ~110 after.

## 8. Settings (rule 15)

- The Staff view IS the operator's primary settings surface (who can do what). It already lives in the brief.
- No new operator-facing settings beyond what the views render.
- Future settings work (display name override, theme, notification preferences) is out of scope.

## 9. Yanai blockers

None. The admin surface runs against existing endpoints.

## 10. Out of scope (deferred)

- Cards list view (needs `GET /cards?status=...`).
- Dashboard time-series charts (needs `/admin/dashboard/timeseries`).
- Deactivate/edit existing staff (needs `PATCH /staff/:id`).
- Per-customer drill-down from Customers list to detail (Customer Detail UI already lives on POS; copying it into admin is its own chunk).
- Pagination on action log (50-row cap is fine for now; future "load more" is small).
- Real 019 SMS provider (separate chunk, irrelevant to admin).

## 11. Alternatives rejected

- **Build the `/cards` list endpoint inside this chunk.** It would double the diff and mix backend + frontend in one commit. Keeping the cards view mock with an honest note is cheaper review surface.
- **Build the time-series endpoint inside this chunk.** Same reason. The charts are decorative; numbers below them are real.
- **Real-time updates (SSE or polling).** Useful but premature; admins refresh manually for now.
- **Modal for staff create.** Heavier UX than an in-line form for a read-mostly view.

## 12. Open questions

None blocking.
