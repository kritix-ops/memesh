# Admin rounds management — define the rounds

**Date:** 2026-07-01
**Author:** Claude (Opus 4.8) for Yoav (Flexelent)
**Why:** There is no UI to configure rounds. The `rounds` / `round_instances`
tables exist but nothing creates or edits them, so there are no rounds, which is
why the dashboard and staff view are empty. User picked "Define the rounds" as
the first slice.

## The materialization problem (load-bearing)

`dashboardLiveRoundsToday` reads `round_instances` for today (joined to the
`rounds` template). Creating a `round` template alone shows nothing — a
`round_instance` for the date must exist, and nothing materializes them today.
So "define the rounds" must cover templates **and** instance materialization.

No schema migration needed — both tables already exist (PR #23).

## Scope (this PR)

Core so rounds become real end-to-end:

- **DB** (`packages/db/src/rounds.ts`, new): `listRounds`, `createRound`,
  `updateRound`, `validateRoundInput`, and `ensureUpcomingInstances` /
  `ensureAllActiveInstances` — idempotent materialization of `round_instances`
  for weekdays matching `daysActive` across a rolling horizon (30 days).
- **API** (`apps/api/src/routes/rounds-admin.ts`, new, admin-only):
  `GET /admin/rounds` (tops up instances for active rounds, then lists),
  `POST /admin/rounds` (create + materialize), `PATCH /admin/rounds/:id`
  (edit + materialize).
- **Admin UI**: a new top-level "סבבים" tab — list of rounds and a create/edit
  form (display name + internal label, start/end time, active weekdays,
  default capacity, active toggle, sort order).

### Materialization semantics (v1)

- On create/edit of an active round, and on each `GET /admin/rounds`, instances
  are ensured for today..today+30 on matching weekdays. Idempotent via the
  `(round_id, date)` unique index. The on-view top-up keeps the window rolling
  as the admin uses the screen; a daily cron can replace it later.
- Instances copy `default_capacity` at creation. Editing a template's capacity
  affects only **new** instances; existing future dates keep their capacity
  (they are meant to be per-date-overridable). The form states this plainly.

## Deferred to the immediate next PR (stated, not silent)

- **Per-date overrides + closures** (editing a specific `round_instance`'s
  capacity, closing/reopening a date). The endpoint + panel are their own chunk;
  the core above is what unblocks everything and lets rounds appear. Building it
  next.
- A proper daily materialization cron (replacing the on-view top-up).
- The rest of the §15 operational knobs (hold TTL, cancellation window, waitlist
  windows, reminders) — the user chose round definitions first.

## Security

Admin-only on all endpoints (matches the other config surfaces). Input validated
server-side (times, capacity bounds, day bitmask, string lengths). No PII.

## Testing

DB helper tests via the PGlite fixture (create/validate/materialize idempotency,
weekday matching, edit). API route test pins the admin gate + body validation.
Admin UI verified by hand across states (empty, create, edit, disable).
