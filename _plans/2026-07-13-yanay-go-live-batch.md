# Yanay go-live batch — 2026-07-13

Source: Yanay's WhatsApp list ("just two last things… then we go live"). Recon
done via three read-only passes over the staff app, the customer app, the API,
and the DB layer. This plan captures what each ask actually needs given what is
already built, and splits it into shippable waves.

## Goals

Close out Yanay's final pre-go-live requests without regressing the live flows,
and — the larger thread from Yoav — give Yanay durable self-serve control over
copy and knobs so he stops needing a code change per wording tweak.

## The five asks and their real state in the code

| # | Ask | Reality found in recon | Verdict |
|---|-----|------------------------|---------|
| 1 | Lock staff marking once a round has passed | `isRoundEnded()` helper already exists (`round-time.ts:56`); arrival only checks `not_today`, not round-end | Small logic change. **Wave 1** |
| 2 | Cancel → email us → we cancel manually → notify customer | Cancel + WooCommerce auto-refund already built and fail-closed (`rounds-cancel.ts`), but current provider (Grow) has **no refund API / no keys**; Yanay is switching providers in ~1-2 days | **Parked** until new provider lands |
| 3a | Customer-area copy: 24h cancel rule, unlimited slot change until original start | Rules already enforced; only the explanatory text is missing | Folds into content system (**Wave 2**); 24h text must render the actual configured window, not a hardcoded "24" |
| 3b | Let Yanay edit texts himself | Only email copy is editable today (`card_settings` + admin Settings) | **Wave 2** — the content system |
| 4 | Cap registration at ~1 month ahead | Horizon is 365 days (`INSTANCE_HORIZON_DAYS`); returned as `maxDate` | Small change, built as a **setting** (Yoav's call). **Wave 1** |

## Waves

- **Wave 1 (this plan, ship for go-live):** #1 staff lock, #4 booking horizon as a
  Yanay-editable setting.
- **Wave 2 (own plan):** comprehensive editable-content system in admin (Yoav
  chose comprehensive over curated); absorbs #3a and #3b. Registry-based so
  adding strings needs no migration; unblankable safe defaults.
- **Parked:** #2 cancellation, waiting on the new payment provider's refund API.

## Wave 1 — approach

### #1 Lock staff marking after a round ends

- **Server (authoritative):** in `setBookingArrival` (`packages/db/src/rounds-arrival.ts`)
  join `rounds`, select `endTime`, and after the existing `not_today` gate return
  a new `round_ended` error when `isRoundEnded(date, endTime, now)`.
- **Route:** `POST /staff/rounds/bookings/:bookingId/arrival` — `round_ended`
  already falls into the 409 branch; only the inline comment changes.
- **Client:** `RoundsView.tsx` gates all attendee controls behind `canMark`
  (currently `isToday`). Change to `isToday && !roundEndedLocal(round.endTime)`.
  An ended round then renders read-only (you can still see who came, not change it).
- **Scope of the lock:** arrival mark + undo + move + walk-in for that round all
  freeze (they share the `canMark` gate). Matches Yanay's "can't mark anything."
- **Grace period (built 2026-07-13, Yoav's call):** a `markingGraceMinutes`
  setting on `round_settings` (default 30) keeps the floor from being cut off
  mid-tap for a straggler. 0 = a hard lock exactly at end time. Enforced server
  side in `setBookingArrival` via the new `isMarkingClosed` helper, threaded to
  the staff client through the `/staff/rounds/today` settings payload so the
  button stays live during the grace window, and editable in the admin סבבים
  settings. Migration `0032`.

### #4 Booking horizon as a setting

- **Schema:** add `bookingHorizonDays` integer to the `round_settings` singleton,
  default 30. One Drizzle migration.
- **Settings layer:** extend `UpdateRoundSettingsInput`, validation (1..365), and
  the persist-changed-only block in `round-settings.ts`, mirroring the existing
  `cancellationWindowHours` field exactly.
- **Enforcement:**
  - Display: `/rounds/availability-range` caps `maxDate` at
    `min(bookingHorizonDays, INSTANCE_HORIZON_DAYS-1)` from venue-today.
  - Authoritative: the booking-create/hold route rejects a target round whose
    date is beyond the horizon (never trust the client — a direct POST must fail).
- **Admin UI:** add a "how far ahead can customers book (days)" numeric field in
  the round-settings form, same style as the cancellation-window field.

## Architecture / boundaries (rule 20)

- Horizon logic lives once: the `bookingHorizonDays` setting is the single source
  of truth, read by both the availability read and the booking-create guard. No
  duplicated "30" literal.
- Time math stays in `round-time.ts` venue helpers; no server-clock date math.
- DB layer (`packages/db`) owns the gate; routes call it; UI only reflects it.

## Security (rule 13)

- #1 and #4 are both authoritative on the server. Client gates are UX only.
- Horizon guard on booking-create is the real control; the capped `maxDate` is
  cosmetic and must not be the only check.
- No new secrets, no new external calls, no PII in new logs.

## Observability (rule 14)

- #1: existing `[staff arrival] set` log stays; the client already logs
  `[staff attendees] mark`. Add nothing noisy; the `round_ended` 409 is
  self-describing.
- #4: log the effective horizon on availability reads and log a rejected
  over-horizon booking attempt with the requested date.

## Settings (rule 15)

- #4 ships as a setting (booking horizon days).
- Candidates surfaced for Wave 2's audit: `markingGraceMinutes` (from #1),
  cancellation-window hours (exists, expose clearly), round names/times/capacity/
  closed-days (confirm already admin-editable), and the full editable-copy set.

## Testing (rule 18)

- #1: unit test on `setBookingArrival` — a round whose end time has passed today
  returns `round_ended`; an in-progress round still marks (fails on old code,
  passes on new).
- #4: `validateRoundSettingsPatch` range test; availability-range `maxDate` cap
  test; booking-create rejection beyond horizon test.
- Run the affected packages' suites, not just the new tests. Known baseline:
  `apps/staff` `staff.test.ts` fails pre-existing under `node --test` (.png
  import) — not a regression.

## Deploy (rule 19)

- Current branch `feat/admin-edit-customer-phone` is off `main`. Wave 1 goes on
  its own branch, PR into `main`, CI, merge triggers deploy. Nothing pushed or
  promoted to `main`/production by hand. #4 adds a migration — confirm the
  deploy runs migrations before the API serves the new column read.

## Open questions

1. #1 scope: `move`/`walk-in` also freeze on an ended round (shared `canMark`
   gate). Left as-is unless Yanay wants those two to stay open post-round.
2. #4/#1 defaults: booking horizon 30 days and marking grace 30 min are the
   seeded defaults — both are now Yanay-editable in admin, so confirm-by-use.

Resolved: #1 grace is a setting (`markingGraceMinutes`, default 30), built
2026-07-13.
