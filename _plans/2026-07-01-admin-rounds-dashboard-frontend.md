# Admin rounds dashboard — frontend (live zones)

**Date:** 2026-07-01
**Author:** Claude (Opus 4.8) for Yoav (Flexelent)
**Extends:** `_plans/2026-06-30-admin-rounds-dashboard.md` (steps 4 through 10)
**Backend contract consumed:** `DashboardLiveResponse` in `apps/api/src/routes/admin.ts`
**Branch:** `feat/admin-rounds-dashboard-fe` off `main`

## What this covers

The frontend for the rounds-aware live dashboard. Backend is done through step 3b:
`GET /admin/dashboard/live` already serves real rounds, stats (with revenue privacy
gate), waitlist, and a 7-day forward grid behind a 5s cache. Alerts are intentionally
`[]` until detection lands. This PR consumes that contract and renders it.

Collapses the plan's steps 4 through 10 into one coherent PR (decision below).

## Two findings from reading the shipped code

1. **The live endpoint didn't expose the display settings the client needs.**
   `getDashboardSettings` carries `capacityWarningPct` (70), `capacityDangerPct` (90),
   `refreshIntervalSeconds` (30), `showWeekAhead` (true). `computeDashboardLive` already
   loads that row but only surfaced `showRevenue` (by stripping fields). The client can't
   know the status thresholds, poll cadence, or week-grid visibility without them, and
   hardcoding would violate the "no hardcoded operational values" rule. Fix: add a
   `settings` block to the live response. Small, first commit of this PR.

2. **The plan named the wrong host component.**
   The plan said extend `apps/admin/src/admin/reports/OverviewReport.tsx`. That is the
   Reports > Overview sub-tab (two clicks deep). The morning-landing dashboard the
   super-brief §11.1.1 and the plan's own goal describe ("open the admin panel in the
   morning ... within five seconds") is the `Dashboard` component at `view === 'dashboard'`
   (nav "לוח בקרה"), the default landing view. Putting the live view where nobody lands
   defeats the goal. Resolution: mount the live zones at the top of `Dashboard`.
   `OverviewReport` stays as the retrospective report it already is.

## Locked decisions (this session)

| Question | Resolution |
|---|---|
| PR scope | One frontend PR, all zones. Backend already serves the data, so an empty skeleton would be fake placeholders (super-brief §11.1.1 forbids). Backend settings-exposure is commit 1 of the same PR. |
| Test infra | Logic-only tests via the existing `node:test` runner. No RTL/jsdom/vitest exists in the repo; not pulling in a DOM test framework for this feature. Zone-hiding verified by manual QA + the endpoint integration test. |
| Widget order | Fixed Option B reading order now. Defer honoring `dashboard_widgets_order` until the settings UI (step 11); the default order already equals Option B, so zero visible difference today. |
| Placement | Top of the `Dashboard` landing component. Live zones built as a self-contained component so they could move if the two overview surfaces are ever consolidated. |

## Layout — Option B, single-column stack

Reading order = priority order, above the existing `Dashboard` widgets:
1. Rounds today (tiles: capacity bar + status pill + free count)
2. Today in numbers (stat tiles + day-over-day delta; revenue tile hidden when gated)
3. Alerts (hidden when empty — always empty for now, lights up when detection lands)
4. Waitlist (hidden when empty)
5. Week-ahead grid (hidden when `showWeekAhead === false`)

Empty zones render `null`, never placeholders. Same code path on phone and desktop;
vertical stack via `useViewport().isMobile`.

## Files

- `apps/api/src/routes/admin.ts` — add `settings` block to `DashboardLiveResponse` + populate it.
- `apps/api/src/routes/admin-dashboard-live.test.ts` — assert the settings block on the 200 path.
- `apps/admin/src/lib/api/admin.ts` — mirror `DashboardLive*` types + `getDashboardLive()`.
- `apps/admin/src/admin/dashboard-live-logic.ts` — pure helpers: status classify, delta
  descriptor, round sort, ILS/number/pct format. No React.
- `apps/admin/src/admin/dashboard-live-logic.test.ts` — node:test for the helpers.
- `apps/admin/src/admin/LiveRoundsDashboard.tsx` — the component + local zone subcomponents
  + refresh indicator. Polling via `setInterval` at `refreshIntervalSeconds`, paused on
  `visibilitychange`, cleaned up on unmount.
- `apps/admin/src/admin/AdminApp.tsx` — mount `<LiveRoundsDashboard />` at the top of `Dashboard`.
- `apps/admin/package.json` — add the new logic test file to the `test` script list.

## Visual style

Existing admin palette only (reused from `reports/shared.tsx`): `ORANGE #ffa983`,
`INK #2d3436`, `MUTED #636e72`, `SHADOW`, `card`. Status colors per plan:
green `#0f9d58`, amber `#f4b400`, red `#d23f31`. Delta up green, down red, zero muted.
Western digits inside Hebrew, `₪` prefix. No gradients, no glassmorphism, no new fonts,
no emojis. Capacity bar is pure CSS (outer `#f3efea`, inner width `pct%`, status color).

## Security

Nothing new to build. Role gate + revenue gate are server-side already. Client never
role-checks and never hardcodes revenue visibility — it infers "hidden" from
`revenueIls === undefined`. Alert messages are server-rendered first-name + last-initial,
so no PII leaks client-side. In-memory React state only, no localStorage. No cost impact
(internal frontend on existing infra).

## QA plan (rule 6)

Data states: empty day (no rounds), partial day, full/over-90% round, revenue gated off
(`revenueIls` absent → tile hidden), week grid off, alerts present (temporary local stub
to eyeball the zone, removed before commit), waitlist present. Golden path + refresh
pause on tab hidden + phone and desktop widths. Typecheck + admin/api/db test suites green.

## Deferred (unchanged from parent plan)

- Alerts detection (server-side) — separate step; zone is ready and hides until then.
- `dashboard_widgets_order` honoring — step 11 with the settings UI.
- Settings UI ("דשבורד" section) — step 11.
- Consolidating the duplicate `Dashboard` / `OverviewReport` overview surfaces — separate cleanup.
