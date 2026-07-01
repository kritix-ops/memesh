# Dashboard settings UI + staff rounds view

**Date:** 2026-07-01
**Author:** Claude (Opus 4.8) for Yoav (Flexelent)
**Two features, two PRs.** Both follow the merged rounds-dashboard work.

## Feature 1 — Admin dashboard settings ("דשבורד" section)

Step 11 of the parent plan. The `dashboard_settings` DB layer (get/update helpers,
validation, tests) already shipped; what was missing was the API endpoints, the SPA
client, and the UI. Scope decision (user): all six settings, wired end-to-end,
including `widgets_order` — so the live dashboard actually honors zone order + hide.

### What ships

- **API** (`apps/api/src/routes/admin.ts`): `GET` + `PATCH /admin/dashboard/settings`,
  admin-only. PATCH validates shape with zod, delegates range/cross-field checks to the
  DB helper, returns the row + diff, and drops the live cache so a change shows on the
  next poll. `widgetsOrder` added to the live response `settings` block so the dashboard
  can honor it without a second request. Route test pins auth/role gate + body validation.
- **SPA client** (`apps/admin/src/lib/api/admin.ts`): `DashboardSettings` types +
  `getDashboardSettings` / `updateDashboardSettings`. `widgetsOrder` added to the live
  settings mirror.
- **UI** (`apps/admin/src/admin/settings/DashboardSettingsSection.tsx`): a self-contained
  "דשבורד" section in the Settings tab (loads/saves on its own, independent of the
  card-settings the rest of the tab uses). Fields: refresh cadence, revenue on/off,
  week-grid on/off, amber/red thresholds, and a zone order + show/hide editor (up/down +
  hide/show, no drag library — matches the plan's "widgets_order is the v1 mechanism").
  Client guards warn ≤ danger and blocks an all-hidden order; server is the source of truth.
- **Live dashboard** (`LiveRoundsDashboard.tsx`): renders zones by `widgetsOrder` (omitted
  key hidden); refresh indicator moved to a top bar so it survives any zone config.
  Defensive fallback to the default order if the API response predates the field
  (admin/API deploy skew).

### Security

Admin-only on both endpoints (stricter than the live dashboard's admin+manager, matching
the card-settings edit surface). `showRevenue` stays enforced server-side by stripping the
revenue fields; toggling it here just flips that gate. No new PII surface.

### Not done here

Server-side alerts detection (still deferred). The staff rounds view is Feature 2.

## Feature 2 — Staff rounds status view (staff.memesh.co.il)

Give shift staff a read-only view of today's rounds so they can see occupancy and know how
to act (which rounds are full, which have space for walk-ins, which have a waitlist).

### Plan

- **API**: a staff-gated `GET /staff/rounds/today` returning today's rounds occupancy +
  waitlist only. No revenue, no PII. Reuses the existing `dashboardLiveRoundsToday` /
  `dashboardLiveWaitlist` DB helpers behind a small cache. Gated to all staff roles
  (cashier/manager/admin), unlike the admin dashboard which is admin/manager.
- **Staff frontend** (`apps/staff`): a rounds status view — occupancy tiles (capacity bar +
  status color + free count) and, per round with waiters, the waitlist count, plus short
  guidance text on what to do when a round is full vs has space.
- Status-color + format logic: small pure helpers, colocated in staff (the admin copy lives
  in `apps/admin` and apps can't cross-import; the functions are a few lines).

### Security

Staff-gated, read-only. Deliberately no revenue and no customer PII — cashiers see
occupancy and waitlist counts, not money or names.
