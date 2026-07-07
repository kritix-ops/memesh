# Jewish Holidays + Shabbat Closures

Date: 2026-07-07
Owner: Yanay (product) / Yoav (tech lead)
Status: approved requirements, implementation starting

## Goal

Let Yanay control, per Jewish holiday and per Shabbat, whether the venue is
Closed, on Special hours, or Normal, and have those decisions apply to the
right (shifting Hebrew-calendar) dates every year with as little manual work
as possible. Holiday dates and Shabbat candle-lighting times come from the
Hebcal API.

## Requirements (from Yanay, locked)

1. Three states per holiday: **Closed** / **Special hours** / **Normal**.
2. Cover all Hebcal categories: yom tov, erev-chag, national and modern days
   (Yom HaAtzmaut, Yom HaZikaron, Purim, Tisha B'Av), minor days and fasts.
3. Auto-sync yearly from Hebcal; Yanay confirms or overrides. A decision set
   once must reapply to the correct date each year without re-entry.
4. Friday early-close derived from Hebcal candle-lighting times.
5. Manual browse view: Yanay sees every holiday and Shabbat with its real date
   and picks Closed / Special hours / Normal per day by hand.

## Approach

Reuse the existing closure engine, do not replace it. The resolver in
`rounds-availability-range.ts` already turns date-scoped `round_schedule_rules`
into per-day `{ closed, roundsRequired, rounds[] }`. We feed it.

Two layers:

- **`holiday_policies`** (new table): Yanay's reusable decision keyed by a
  stable holiday identity, so "Yom Kippur = closed" persists across years even
  as the Gregorian date moves. Shabbat is one row (`holidayKey = 'shabbat'`)
  carrying a candle-lighting offset.
- **Concrete dated rows** in `round_schedule_rules`: the sync materializes one
  single-date row per closed/special-hours occurrence for the target year.
  These carry a new `source` tag ('holiday_sync') and a `source_key` so the
  sync can re-run idempotently and NEVER touch a `source = 'manual'` row. The
  resolver is unchanged for closed days.

Hebcal is a **suggestion + date feed behind a confirm step**, never a live
resolver input. If Hebcal is unreachable, nothing changes and nothing closes.

### Engine extension (needed for Special hours + Friday early-close)

`round_schedule_rules` today expresses closure only as round-windows or
full-day closed. Add two nullable columns `open_from` / `open_until` (time) that,
on a `free_play` day, mean "the venue is open only between these times." The
resolver keeps the day sellable and surfaces the hours; a hard intraday sale
cutoff is out of scope for v1 (see Open questions).

### Sync flow (admin-triggered button, not cron in v1)

1. Fetch Hebcal for the year: holidays (`i=on&lg=he` + all category flags) and
   Friday candle-lighting (`c=on` + venue geo + offset).
2. Upsert `holiday_policies` rows for any new holiday key found, default
   `policy = 'normal'`, `confirmed_at = null` so new holidays surface for review.
3. Regenerate `source = 'holiday_sync'` dated rows for the year from confirmed
   policies. Delete stale sync rows for that year first (idempotent rebuild).
4. Manual rows and unconfirmed policies are left untouched.

### Admin browse view (`apps/admin`)

A 12-month calendar / list showing each holiday and Friday with its real date
and plain-Hebrew name. One control per day: Normal / Special hours / Closed
(+ open/close time inputs when Special hours). Undecided (`confirmed_at = null`)
days are visually flagged. Buttons: "Import next year from Hebcal" (suggests,
never overwrites) and per-row confirm.

## Alternatives rejected

- **Store policy keyed to Gregorian dates only** (no holiday identity): simpler,
  but then every year is manual re-entry. Fails requirement 3.
- **Separate resolver input consulted alongside rules**: cleaner separation but
  adds precedence logic to the one code path that decides whether sales are on.
  Reusing `round_schedule_rules` keeps a single, already-tested closure path.
- **Cron auto-sync in v1**: a silent 3am job that can close the venue. Deferred;
  admin-triggered with a visible result first.

## Security

- Sync and policy writes are admin-only (existing `/admin` auth).
- Hebcal is read-only, no key, no PII sent (we send only year + venue geo).
- Fail-closed on auth, fail-OPEN on data: an empty/failed Hebcal response never
  produces a closure. Only a confirmed policy or a manual row can close a day.

## Observability

- `[holidays sync]` logs: year, holidays fetched, new keys, rows generated,
  rows deleted, Hebcal status. `[holidays resolve]` when a holiday rule closes a
  day. Namespaced per Yoav rule 14.

## Settings

- New: Shabbat candle-lighting offset (minutes before) and venue geo
  (lat/long or GeoNames id) live in `round_settings` (or a small
  `venue_settings`). Default offset 40 min, venue geo = the play center.
- Master "holiday closures enabled" toggle so the whole layer can be switched
  off without deleting policies.

## Testing (unit, per Yoav rule 18)

- **Safety invariant**: no policy/sync combination makes a `normal` day
  unsellable; an empty Hebcal response generates zero closure rows.
- Holiday key normalization (year suffixes like "Rosh Hashana 5787" collapse to
  a stable key; multi-day markers preserved).
- Sync idempotency: running twice yields identical rows; never deletes manual
  rows; unconfirmed policies generate nothing.
- Resolver: closed policy closes the date; special-hours keeps it sellable with
  hours; Friday offset computed via venue-TZ helpers (round-time.ts), correct
  across DST.

## Deploy

- Standard flow: PR into `main`, migration `0028_holiday_policies` +
  `round_schedule_rules` columns, registered in the drizzle journal. No direct
  pushes to `main`. The WP snippet already renders `closed` days, so no snippet
  change needed for closures.

## Open questions (one, non-blocking)

- **Special hours / Friday for day-granular online tickets**: online sales are
  per-day, so "open until 13:00" is informational for v1 (day stays sellable,
  Saturday already closed by the weekly rule). If Yanay wants a hard "stop
  selling after HH:MM" cutoff, that is a small v2 follow-up. Proceeding with
  display semantics; will confirm with Yanay.

## Build order

1. Hebcal client + response types (verified shape) + holiday-key normalization. Tests.
2. `holiday_policies` schema + `round_schedule_rules` `source`/`source_key`/
   `open_from`/`open_until` columns. Migration 0028. Register in journal.
3. Sync service (fetch → upsert policies → regenerate dated rows). Tests.
4. Resolver extension for free-play open/close hours. Tests.
5. Admin API endpoints (list calendar, set policy, run sync). Tests.
6. Admin browse UI. Manual QA.
