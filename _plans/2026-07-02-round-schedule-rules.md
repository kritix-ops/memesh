# Round schedule rules — time windows, ranges, recurrence (replaces off dates)

Date: 2026-07-02
Status: approved in chat (Yoav's three answers), building.

## Goal

Full flexibility over WHEN the rounds system applies (Yoav, dev-phase):
- Whole-day off, or rounds limited to specific time windows in a day
  ("rounds only 14:00–16:00 and 18:00–19:00 on date X").
- Rules for a single date, a range of dates, recurring weekdays, or a
  weekday pattern inside a range ("Fridays in July").
- Per rule, what the rest of the day is: **free play** (tickets sell without
  a round) or **closed** (rounds are the only way in).

## Decisions (Yoav 2026-07-02)

1. Outside-window behavior is per-rule: `free_play` | `closed`.
2. A round counts as inside a window only when it **fits entirely**.
3. Scopes: single date, bounded date range, recurring weekdays, and
   weekday-in-range combinations.

## Model

Table `round_schedule_rules` (migration 0024; also DROPS `round_off_dates`,
which shipped hours earlier in 0023, was superseded before anyone stored
data in it, and would otherwise be a second overlapping knob):

- `date_from` / `date_to` (nullable dates) + `weekday_mask` (nullable,
  bit 0 = Sunday). At least one of date_from/weekday_mask required;
  date_to requires date_from. A date matches when it is inside the range
  (open-ended sides pass) AND its weekday is in the mask (null mask = all).
- `windows`: jsonb `[{start:"HH:MM", end:"HH:MM"}]`, sorted, non-overlapping,
  max 8. Empty array = no rounds at all on matched days.
- `outside`: `free_play` | `closed`.
- `note`: optional admin label ("חנוכה").

**Resolution** for a date, when several rules match: single-date rule
(`date_from = date_to`) > bounded range > recurring; ties → most recently
updated. One winner; no merging (predictable for a lazy admin).

**Effective availability** for date D (route composition):
- master `rounds_enabled` off or no active rounds → `roundsRequired:false`,
  rounds `[]`.
- no matching rule → `roundsRequired:true`, all open rounds (status quo).
- rule with windows: rounds filtered to those fitting entirely inside any
  window. `roundsRequired = (outside === 'closed')`. So a free-play rule
  with windows yields an OPTIONAL picker (rounds offered, none required);
  a closed rule yields a mandatory picker over the filtered list, and with
  `windows: []` nothing is purchasable that day.

**Enforcement depth**: besides availability, `createHold` (WC + customer)
and `bookRoundWithPunch` re-check the rule (`isInstanceSchedulable`) and the
master switch, so a direct API call cannot book a filtered-out round.
`swapBooking` is a known follow-up gap (noted, low risk: admin-visible).

## Surfaces

- Admin Rounds page: rules manager replaces the off-dates chips. Create
  form (scope type → fields, windows editor, outside radio, note) + rule
  cards with human-readable summary + delete. Create/delete only in v1 —
  editing = delete + recreate.
- WP snippet: picker offers "ללא סבב — כניסה חופשית" as the default option
  when `roundsRequired:false` but rounds exist (free-play windows);
  hides the round field entirely when no rounds; unchanged when required.
  Server-side per-date validation already keys off `roundsRequired`.
- Customer punch modal: books only from the filtered list (server-side);
  free-play empty days show the existing "free entry" message.

## Security

Rules CRUD is admin-only (same requireRoleHook('admin') as rounds CRUD).
Public availability exposes only the computed result, never the rules.
Booking-path guards fail closed ('closed' error) on filtered-out rounds.

## Observability

`[rounds schedule]` logs on rule create/delete (scope + windows + outside),
resolver outcome logged inside availability's existing log line
(roundsRequired), guard rejections logged by the hold/punch paths.

## Testing

- db: rule validation (windows/scopes), resolver specificity + matching,
  fit-entirely matcher, hold/punch guard behavior, CRUD.
- api: admin route gates; availability composition covered at db level.
- SPA: typecheck (existing convention).

## Deploy

One PR into main; migration 0024 (create rules + drop round_off_dates)
runs on the production build — the journal fix (PR #59) makes that safe
again. Rollback = revert.
