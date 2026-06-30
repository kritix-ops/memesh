# Admin rounds dashboard — design + build plan

**Date:** 2026-06-30
**Author:** Claude (Opus 4.7) for Yoav (Flexelent)
**Builds on:**
- `memesh-rounds-super-brief.md` §11.1.1 (what the dashboard contains) + §15.3 (settings)
- Existing [`apps/admin/src/admin/reports/OverviewReport.tsx`](../apps/admin/src/admin/reports/OverviewReport.tsx) (the current dashboard surface — punch-card focused)
- Existing palette + components in [`apps/admin/src/admin/AdminApp.tsx`](../apps/admin/src/admin/AdminApp.tsx): `ORANGE = '#ffa983'`, `INK = '#2d3436'`, `MUTED = '#636e72'`, `SHADOW = '0 4px 20px rgba(0,0,0,0.08)'`, the `card` style block, `StatTile`, `EmptyState`

## Goal

When Yanay or Inbal open the admin panel in the morning (or check from phone mid-shift), the dashboard must tell them within five seconds:

1. Are we full today / about to be?
2. Is anything broken (payment-received-no-slot, stuck holds, full rounds with growing waitlist)?
3. How's the money compared to yesterday?

No clicks, no scrolling on desktop, identical behavior on phone. Beautiful in a way that doesn't look like a SaaS template.

## What's new vs. the existing OverviewReport

Today the dashboard shows static stat tiles (entries-24h, cards-sold-30d) + dormant customers + recent staff actions. It's a *retrospective* surface. The rounds dashboard adds the *live operational* layer the existing one is missing:

| Existing OverviewReport | What we're adding |
|---|---|
| Cards sold last 30d | Today's revenue (live, with day-over-day delta) |
| Entries last 24h/7d/30d | Today's bookings (live, by source) |
| Dormant customers | Today's rounds, live occupancy per round |
| Recent staff actions | Active alerts (only when present) |
| — | Live waitlist activity per round |
| — | 7 days forward occupancy grid |

The existing widgets stay. The new ones live above them.

## Constraints

- **No new heavy dependencies.** No Chart.js, no D3, no Recharts. Sparklines and bars are inline SVG.
- **No Tailwind.** Matches the existing inline-style pattern in `AdminApp.tsx`. Mixing the two in one file is the disorder rule 2 forbids.
- **Hebrew RTL primary.** Numbers use western digits, currency uses `₪` prefix per RTL convention.
- **Mobile parity.** Same content on phone and desktop, vertical stack on narrow viewports (already the existing pattern via `useViewport`).
- **Admin role only.** No public surface, no leaked PII.
- **Performance.** Initial render < 200ms on mid-range phone, refresh < 100ms.

## Three layout alternatives

### Option A — Strip + Sidebar (density-first)

```
┌────────────────────────────────────────────────────────────────────┐
│ Memesh Admin · דשבורד                          🔄 רענון אוטומטי 30s │
├─────────────────────────────────────────────────┬──────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐         │ ₪3,420            │
│ │16:00-18  │ │18:00-20  │ │20:00-22  │         │ הכנסה היום        │
│ │38/50 76%│ │22/50 44%│ │ 6/50 12%│         │ ▲ +12% מאתמול     │
│ │ ████████░│ │ ████░░░░░│ │ █░░░░░░░░│         │                   │
│ └──────────┘ └──────────┘ └──────────┘         │ 24 הזמנות         │
│                                                  │ 5 holds פעילים    │
├─────────────────────────────────────────────────┤ 3 כרטיסיות נמכרו  │
│ ⚠ התראות (2)             ⏳ ממתינים (4)         │                   │
│ • payment_no_slot 16:00  • 16:00 · 2           │                   │
│ • hold תקוע 14 דק'       • 18:00 · 2           │                   │
├─────────────────────────────────────────────────┴──────────────────┤
│ 7 ימים קדימה — grid                                                  │
└────────────────────────────────────────────────────────────────────┘
```

**Summary.** Two-column desktop layout: rounds + alerts + waitlist on the main column, key numbers in a fixed right sidebar (RTL: left-rail).

**Pros:** Most info visible above the fold. Sidebar gives revenue/holds permanent presence. "Command center" feel.

**Cons:** Two-column collapses awkwardly on narrow viewports. Sidebar can read as a generic SaaS dashboard pattern unless we work hard on type and spacing. The mix of grid + sidebar costs the most CSS work of the three.

### Option B — Single Column Stack (mobile-first) — RECOMMENDED

```
┌─────────────────────────────────────────────────────┐
│ Memesh Admin · דשבורד · רענון אוטומטי 30s          │
├─────────────────────────────────────────────────────┤
│ סבבי היום                                            │
│ ┌─────────────────────────────────────────────┐    │
│ │ סבב 16:00–18:00              [צהוב] 76%    │    │
│ │ ████████░░  38 / 50 ילדים     12 פנויים    │    │
│ └─────────────────────────────────────────────┘    │
│ ┌─────────────────────────────────────────────┐    │
│ │ סבב 18:00–20:00              [ירוק] 44%    │    │
│ │ ████░░░░░░  22 / 50 ילדים     28 פנויים    │    │
│ └─────────────────────────────────────────────┘    │
│ ┌─────────────────────────────────────────────┐    │
│ │ סבב 20:00–22:00              [ירוק] 12%    │    │
│ │ █░░░░░░░░░   6 / 50 ילדים     44 פנויים    │    │
│ └─────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────┤
│ היום במספרים                                         │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                │
│ │₪3,420│ │  24  │ │  5   │ │  3   │                │
│ │הכנסה │ │הזמנות│ │holds │ │כרטיס.│                │
│ │▲ +12%│ │▲ +3  │ │      │ │ = 0  │                │
│ └──────┘ └──────┘ └──────┘ └──────┘                │
├─────────────────────────────────────────────────────┤
│ ⚠ התראות (2)                                         │
│ • payment_received_no_slot · 16:00 · לפני 3 דק'    │
│ • hold תקוע 14 דק' · Sigal Cohen                   │
├─────────────────────────────────────────────────────┤
│ ⏳ רשימת המתנה (4)                                   │
│ • 16:00 · 2 ממתינים · אחרון notified לפני 2 דק'    │
│ • 18:00 · 2 ממתינים                                  │
├─────────────────────────────────────────────────────┤
│ 7 ימים קדימה                                          │
│        א'  ב'  ג'  ד'  ה'  ו'  ש'                   │
│ 16:00 ██ ██ ██ ██ ██ ░░ ░░                          │
│ 18:00 ██ ██ ██ ██ ██ ░░ ░░                          │
│ 20:00 ██ ░░ ░░ ░░ ░░ ░░ ░░                          │
├─────────────────────────────────────────────────────┤
│ [Existing OverviewReport content below]              │
│ — לקוחות שלא ביקרו 30+ ימים                          │
│ — יומן פעולות אחרונות                                 │
└─────────────────────────────────────────────────────┘
```

**Summary.** One vertical column. Reading order = priority order: rounds → numbers → alerts → waitlist → forward view → legacy widgets. Empty zones (no alerts, no waitlist) disappear cleanly — no placeholders.

**Pros:**
- Phone and desktop run the same code path. Yanay can check from the venue floor on his phone and get identical hierarchy.
- Lazy-user friendly (rule 10): top-to-bottom = most-urgent-to-least.
- Matches the existing OverviewReport pattern (already vertical sections inside a `flexDirection: column` wrapper). Slots in cleanly per rule 2.
- Empty zones genuinely vanish — no "no alerts" placeholder card eating real estate.
- Cheapest to build well. No grid/sidebar CSS to fight.

**Cons:**
- Requires some scroll on a desktop monitor for the legacy widgets at the bottom. The new rounds-aware widgets fit above the fold; legacy ones are intentionally below.
- Less visually impressive on first open. Trade is intentional — flashy is what we're avoiding (rule 5).

### Option C — Hero Number + Card Grid (one-glance-first)

```
┌──────────────────────────────────────────────────────┐
│ Memesh Admin · דשבורד                                 │
├──────────────────────────────────────────────────────┤
│                                                       │
│                  44% תפוסה היום                       │
│                  66 / 150 ילדים                       │
│                  ₪3,420 · 24 הזמנות                   │
│                                                       │
├──────────────────────────────────────────────────────┤
│ ┌────────────┐ ┌────────────┐ ┌────────────┐        │
│ │ סבבי היום  │ │ התראות (2) │ │ ממתינים (4)│        │
│ │ [tiles]    │ │ [list]     │ │ [list]     │        │
│ └────────────┘ └────────────┘ └────────────┘        │
├──────────────────────────────────────────────────────┤
│ 7 ימים קדימה [grid]                                   │
└──────────────────────────────────────────────────────┘
```

**Summary.** One large hero metric on top (today's aggregate occupancy + headline numbers), three equal-weight cards below, week-ahead grid at the bottom.

**Pros:** Single-glance comprehension if the right hero is chosen. Most minimalist of the three. Visually striking.

**Cons:**
- The hero metric is fragile. Revenue? Occupancy? Both? Different choices at different times. Whichever we pick hides the other under abstraction.
- The three-card grid below is the most stereotyped "AI template" shape of the three options. Looks SaaS-generic unless we work hard against it (rule 5).
- Doesn't collapse to phone gracefully — the grid stacks vertically anyway, at which point we're at Option B with extra steps.
- Equal-weight cards is wrong: alerts (when present) are massively more urgent than waitlist, but visually identical in a 3-up grid.

## Recommendation

**Option B.** Mobile parity + clear priority order + cheapest correct build + matches the existing pattern. Reject A and C — A for the responsive cost and sidebar-template feel, C for hero fragility and the grid-template feel.

If Yanay later wants more density on desktop, we can add a `dashboard_layout = 'spacious' | 'dense'` setting that switches Option B into a two-column variant on wide viewports. Don't pre-build that.

## Visual style

Matches the existing admin palette exactly. No new colors, no gradients, no glassmorphism.

| Token | Value | Use |
|---|---|---|
| `ORANGE` | `#ffa983` | Brand accent — used sparingly: header underline, focus rings, the "live" pulse dot on the refresh indicator |
| `INK` | `#2d3436` | Primary text |
| `MUTED` | `#636e72` | Secondary text, labels, "12 פנויים" |
| `BG` | `#fafaf8` | Page background (cream — already in use) |
| `CARD_BG` | `#fff` | Card surface |
| `SHADOW` | `0 4px 20px rgba(0,0,0,0.08)` | Existing soft card shadow — keep |
| Status green | `#0f9d58` | Occupancy < `dashboard_capacity_warning_pct` (default 70%) |
| Status amber | `#f4b400` | Occupancy 70–90% |
| Status red | `#d23f31` | Occupancy ≥ `dashboard_capacity_danger_pct` (default 90%) or alerts |
| Delta up | `#0f9d58` | ▲ +12% |
| Delta down | `#d23f31` | ▼ -8% |

**Typography.** Reuses the admin app's existing stack from [`apps/admin/src/index.css`](../apps/admin/src/index.css):

```css
font-family: 'Ploni', 'Assistant', 'Rubik', system-ui, sans-serif;
```

`Ploni` is the primary (custom-loaded brand font, `@font-face` declared in `index.css`). `Assistant` is the Google Fonts fallback loaded in [`index.html`](../apps/admin/index.html). No new font request — anything beyond the existing stack is wasted bytes and inconsistency.

Western digits everywhere, even inside Hebrew sentences. Number sizes: hero `28px/600`, stat-tile value `22px/600`, body `14px/400`, label `12.5px/500 muted`. Monospace (`'ui-monospace, monospace'`, already used in `AdminApp.tsx`) for serial numbers and IDs only.

**Spacing.** 8/12/16/20/24 scale — match the existing `gap: 16` / `padding: 20` rhythm in `OverviewReport.tsx`.

**Round occupancy bar.** Pure CSS: outer `div` with `background: #f3efea` (existing divider color), inner `div` width `${occupancy_pct}%`, background = status color. No SVG, no animation library. Bar height 6px. Border-radius matches outer container.

**Status pill** (the colored "[צהוב] 76%" label). 12px text, 600 weight, 4px padding, background = status color at 12% opacity, text = status color at full. RTL-safe. Reuses the same green/amber/red.

**Refresh indicator.** Small `●` dot in `ORANGE` that pulses (CSS animation, 2s ease-in-out infinite) next to "רענון אוטומטי 30s" text. Pause animation when tab is hidden (use `visibilitychange`) — both to avoid wasted CPU and to communicate "we're paused too."

## Data layer

### Endpoint strategy — add alongside, don't fold

Two endpoints, not one:

| Endpoint | What | Refresh | Cache TTL | Security gates |
|---|---|---|---|---|
| `getDashboardStats` (existing) | Retrospective stats: entries 24h/7d/30d, cards sold 30d, dormant customers, expiring soon, new customers 7d | On mount, manual | 60s server-side | Admin/manager role |
| `GET /admin/dashboard/live` (new) | Live operational: today's rounds, holds, alerts, waitlist, week-ahead, today's revenue with day-over-day delta | Every 30s | 5s server-side | Admin/manager role + revenue privacy gate |

**Why two endpoints, not one.** Different cache TTLs (5s vs 60s), different refresh cadences (30s polling vs mount-only), different security surfaces (only the new one has the revenue privacy gate). Folding them means either the cheap-to-cache retrospective stats get over-refreshed, or the live data gets under-refreshed, or the cache logic has to branch per field. Adding alongside keeps each endpoint's concern clean. The existing `getDashboardStats` stays exactly as it is, the legacy widgets at the bottom of the dashboard keep using it. Decision per rule 2 (don't disorder existing structure for a new feature).

**Why not deprecate `getDashboardStats`.** It works, it's wired to live UI, it's not blocking the new work. Replacing it for the sake of consolidation is exactly the "premature refactor" rule 6 / general engineering hygiene warns against.

### New endpoint: `GET /admin/dashboard/live`

One round-trip per refresh. Server-side aggregation to keep the client dumb.

```ts
// Response shape
{
  asOf: string;                          // ISO timestamp — for "data is X seconds stale" display if needed
  today: {
    rounds: Array<{
      roundInstanceId: string;
      label: string;                     // "סבב אחר הצהריים"
      startTime: string;                 // "16:00"
      endTime: string;                   // "18:00"
      capacity: number;
      taken: number;                     // confirmed + used + active holds
      heldCount: number;                 // just active holds, for "5 holds" stat
      pctFull: number;                   // 0..100, rounded
      isClosed: boolean;
    }>;
    stats: {
      revenueIls: number;
      revenueDeltaPct: number | null;    // vs same time yesterday
      bookingsCount: number;
      bookingsDelta: number | null;
      activeHoldsCount: number;
      punchCardsSold: number;
      punchCardsDelta: number | null;
    };
  };
  alerts: Array<{                        // empty array when none — UI hides the whole zone
    id: string;
    kind: 'payment_received_no_slot' | 'stuck_hold' | 'round_full_growing_waitlist';
    message: string;                     // pre-rendered Hebrew, server-localized
    contextHref: string;                 // where clicking takes you (round detail, customer detail, etc.)
    occurredAt: string;
  }>;
  waitlist: Array<{                      // empty when no rounds have waiters
    roundInstanceId: string;
    label: string;                       // "סבב 16:00"
    waitingCount: number;
    lastNotifiedAt: string | null;
  }>;
  weekAhead: Array<{                     // 7 days × ALL rounds matrix (every active round appears every day)
    date: string;
    rounds: Array<{
      roundInstanceId: string | null;    // null when this round does NOT run on this date (e.g., Friday off)
      label: string;                     // always present — the round's stable display name
      startTime: string;                 // for sorting and the grid's row label
      pctFull: number | null;            // null when roundInstanceId is null
      isClosed: boolean;                 // true when round is manually closed on this date (event, holiday)
    }>;
  }>;
}
```

### Caching

- **Server-side**: in-memory cache per process, 5s TTL. With ~30s client refresh, prevents the same minute's six refreshes from hammering the DB. Per-key cache: `dashboard:live:${date}`.
- **Client-side**: simple state in the component. Skip SWR/React Query — adds a dep, the existing OverviewReport doesn't use one, and the polling pattern is dead simple. Use `setInterval` cleared in the effect cleanup.
- **WebSocket**: no. Over-engineering for 30s refresh. Revisit only if Yanay asks for "instant" alerts.

### Day-over-day delta logic

`revenueDeltaPct` etc. compare today's running total at this hour against yesterday's running total at the same hour. Not yesterday's full-day total — that would be misleading at 10am. If the comparison hour is in the future (e.g., it's currently 11:30 but yesterday's data point at 11:30 doesn't exist because yesterday was a closed day), return `null` and the UI shows no delta arrow.

## Security

- **Role gate**: `requireRole(['admin', 'manager'])` middleware on `GET /admin/dashboard/live` — same pattern as the existing `/admin/cards` endpoints. Reject with 403 otherwise.
- **Revenue privacy**: the `revenueIls` and `revenueDeltaPct` fields are stripped server-side when `dashboard_show_revenue=false` OR when the requesting user's role is below `manager`. Don't filter on the client — never trust the client.
- **No PII in alerts**: alert messages reference customer by first name + last initial ("Sigal C.") not full name + phone. Full context lives behind the `contextHref` click, gated by the same role middleware.
- **No client cache that survives logout**: in-memory React state only, evaporates on tab close. No localStorage.
- **Rate limit**: existing global rate limit on `/admin/*` is sufficient. 30s refresh = 2 req/min/user. Well under any sane cap.

## Observability (rule 14)

Every meaningful event logs with a `[dashboard ...]` namespace so we can grep cleanly:

| Event | Log |
|---|---|
| Page mount | `console.info('[dashboard mount]', { user: userId, viewport })` |
| Fetch start | `console.info('[dashboard fetch start]', { iso: now })` |
| Fetch success | `console.info('[dashboard fetch success]', { ms, alerts: n, rounds: n })` |
| Fetch failure | `console.warn('[dashboard fetch fail]', { ms, status, error })` |
| Alert click | `console.info('[dashboard alert click]', { kind, alertId, contextHref })` |
| Threshold transition | `console.info('[dashboard round threshold]', { roundInstanceId, from: 'green', to: 'amber', pctFull })` |
| Visibility change | `console.info('[dashboard visibility]', { hidden, willPauseRefresh })` |
| Widget hidden by setting | `console.info('[dashboard widget hidden]', { widgetKey, reason: 'settings' })` |

Server-side mirrors with `logger.info('[api dashboard ...]')` on the endpoint: request received, cache hit/miss, response size, total ms. If a request takes > 500ms server-side, log at `warn` with the query timing breakdown.

## Settings (rule 15)

Already specified in Super Brief §15.3. No new settings beyond those six. If we discover during build that something else needs flexibility, add to §15.3 first, then code — never code a hardcoded value and "we'll make it a setting later."

## Testing (rule 18)

**Unit tests** (`apps/admin/src/admin/reports/dashboard.test.tsx` or similar):
- `computeStatusColor(pct, warnPct, dangerPct)` → returns `'green' | 'amber' | 'red'` correctly for boundary values (69.9, 70, 89.9, 90, 100).
- Delta arrow rendering: `null` → no arrow, positive → up + green, negative → down + red, zero → "=" + muted.
- Sort order: rounds ordered by `startTime`, alerts ordered by `occurredAt` descending.

**Integration tests** (`apps/api/src/routes/admin-dashboard.test.ts`):
- `GET /admin/dashboard/live` with admin role → 200 + full shape.
- Same endpoint with cashier role → 403.
- Same endpoint with `dashboard_show_revenue=false` setting → `revenueIls` is omitted from response.
- Cache hit behavior: two calls within 5s return identical `asOf` timestamp.
- Empty state: no rounds today → `today.rounds = []`, no error.

**Component tests** (React Testing Library):
- `RoundTile` empty state ("הסבב סגור היום").
- `AlertsZone` returns `null` when alerts array is empty (zone vanishes — assert no DOM rendered).
- `RefreshIndicator` pulses when visible, stops when `document.hidden = true`.

**Visual / E2E**:
- Cypress or Playwright (whichever the repo uses — check before adding) test that opens the dashboard as admin, asserts each zone is present, asserts an alert click navigates to `contextHref`.

**No tests on the math formulas** (`revenueDeltaPct`) at the unit level beyond the boundary tests — that's just arithmetic, the integration test verifies the wired-up answer.

Bug-fix discipline: any bug found during build gets a failing test FIRST, then the fix. Per rule 18.

## Deploy (rule 19)

Standard PR flow into `main`. Specifically:

1. Branch from `main` → `feat/admin-rounds-dashboard`.
2. Commits as we go, never amending pushed commits.
3. Open PR to `main` when build is green locally (typecheck + tests + lint).
4. CI runs (existing GitHub Actions, no new workflow file).
5. On merge to `main`, Vercel auto-deploys preview → promotion to production happens via Vercel's standard pipeline (not by hand).

**What I will NOT touch without explicit approval:**
- `main` branch (no direct push)
- Production deploys (no manual promotion)
- The `vercel.json` / project config (no rewrites, redirects, or env changes for this feature)
- Anything in `apps/customer/` or `apps/staff/` outside of shared `@memesh/web-shared` types

**Rollback path**: revert the PR, Vercel re-deploys previous main. No DB migration in this feature so no migration to roll back.

**No feature flag** for the new dashboard widgets — they sit alongside the existing OverviewReport content, and the worst case if data is missing is empty zones (which we already designed to hide cleanly). A flag would be ceremony without value.

## Implementation steps (rough order)

1. **API endpoint scaffold** — `GET /admin/dashboard/live` returning the shape above with stubbed data. Wire up role gate + revenue privacy gate. Tests for both.
2. **Replace data layer** — real queries against `bookings`, `round_instances`, `waitlist_entries`, existing punch_card tables. Add the 5s in-memory cache.
3. **New `dashboard_settings` table** — own table, NOT a `card_settings` extension. The dashboard's settings are conceptually unrelated to card-product config and bundling them in `card_settings` would entangle two concerns. Migration `0014_dashboard_settings.sql`:

   ```sql
   CREATE TABLE "dashboard_settings" (
     "id" smallint PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),  -- singleton row pattern
     "refresh_interval_seconds" smallint NOT NULL DEFAULT 30,
     "show_revenue" boolean NOT NULL DEFAULT true,
     "show_week_ahead" boolean NOT NULL DEFAULT true,
     "capacity_warning_pct" smallint NOT NULL DEFAULT 70 CHECK ("capacity_warning_pct" BETWEEN 0 AND 100),
     "capacity_danger_pct" smallint NOT NULL DEFAULT 90 CHECK ("capacity_danger_pct" BETWEEN 0 AND 100),
     "widgets_order" jsonb NOT NULL DEFAULT '["rounds_today","stats_today","alerts","waitlist","week_ahead"]'::jsonb,
     "updated_at" timestamptz NOT NULL DEFAULT now()
   );
   INSERT INTO "dashboard_settings" ("id") VALUES (1);
   ```

   Singleton-row pattern (the `CHECK id=1`) matches the existing settings table convention. Drizzle schema + `getDashboardSettings()` / `updateDashboardSettings()` helpers live in `packages/db/src/schema/dashboard-settings.ts`.
4. **Frontend skeleton** — copy `OverviewReport.tsx` shape, add new zones above the existing widgets. Inline styles matching existing pattern.
5. **Round tile component** — capacity bar + status pill. Pure, no state.
6. **Stats tile evolution** — extend `StatTile` with optional delta prop, or add new variant.
7. **Alerts zone** — list with click handlers. Hides when empty.
8. **Waitlist zone** — list. Hides when empty.
9. **Week-ahead grid** — 7×N matrix with status colors. Hides per setting.
10. **Polling + visibility pause** — `setInterval` + `visibilitychange` listener.
11. **Settings UI** — extend `Settings.tsx` with a "דשבורד" section exposing the 6 settings. Match existing settings UX.
12. **Tests** — unit + integration + component, then E2E.
13. **Manual QA pass** — open the dashboard with various data states (empty day, full day, alerts present, alerts absent). Phone + desktop.

Each step is a single logical commit. Don't batch.

## Decisions locked (resolved before build start)

| Question | Resolution |
|---|---|
| Hebrew font in admin app | `'Ploni', 'Assistant', 'Rubik', system-ui, sans-serif` — existing stack from [`apps/admin/src/index.css`](../apps/admin/src/index.css). No new font request. |
| Salvage `getDashboardStats` vs new endpoint | **New endpoint alongside.** `getDashboardStats` keeps powering the legacy retrospective widgets; `/admin/dashboard/live` powers the new live-operational widgets. Different cache TTLs, different security gates, different refresh cadences — separate endpoints. |
| 7-day forward grid: all rounds across days, or only rounds running on each date | **All rounds across all days.** Every active round appears every day; if a round doesn't run on a given day (e.g., Friday off) the cell shows "סגור" in muted gray, `roundInstanceId: null`. Keeps the grid shape stable and scannable. |
| `dashboard_settings` table vs extending `card_settings` | **New `dashboard_settings` table** (singleton-row pattern, migration `0014`). Card config and dashboard config are unrelated concerns — bundling them entangles the schema. |

## Open questions (post-build, low priority)

None blocking. If any emerge during step-by-step build, they get added back here as discovered.

## Out of scope (defer)

- Custom date-range comparison (week-over-week, month-over-month). Today's view + 7-day forward is enough for v1.
- Export to CSV from the dashboard. The existing Reports tab handles that.
- Push notifications for alerts. Server-side log is enough until Yanay says he's missing them.
- Multi-store support. Memesh is one location.
- Drag-to-reorder widget customization. `dashboard_widgets_order` JSON setting is the v1 mechanism; a drag UI can come later.
- "Compare to last week" toggle on stats tiles. Day-over-day is the operationally useful comparison; week-over-week is a vanity metric for now.
- A dedicated mobile app shell. The responsive web view is the mobile experience.

---

*Plan ends. Next action after approval: confirm the four open questions above, then start with step 1 (API endpoint scaffold) in a fresh branch off `main`.*
