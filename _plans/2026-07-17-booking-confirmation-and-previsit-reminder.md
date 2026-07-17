# Booking confirmation (#10) + pre-visit reminder (#11) — Yanay, 2026-07-17

Status: implemented on branch `feat/wave2-staff-content`, tests green, NOT
committed. Backend-only; complements the parallel customer-app "pre-booking
rules popup" work (separate plan) — no file overlap except the content registry.

## Goal
Two of Yanay's booking-clarity asks that are notifications, not on-screen text:
- **#10** — the moment a round booking is confirmed, show an in-app recap (already
  shipped in the punch flow) and send a confirmation **email + SMS**.
- **#11** — before the visit, send a **pre-visit reminder** ("מחכים לכם מחר…") with
  the rules recap.

## Context / what already existed
- The customer area books rounds only via **punch cards** (`bookRoundWithPunch`);
  paid purchases run on WooCommerce (out of scope, Yoav's call). So #10 hooks the
  punch booking path.
- A **stay-duration** reminder already existed (super-brief §9): "your round ends
  in N minutes", END-based, today-only, hardcoded text, fired by the per-minute
  `/cron/rounds-reminders` route. #11 is a **START-based** sibling that reuses the
  same claim/cron machinery.
- Server-side editable copy pattern: `getMergedContent(db)` + `resolveContent()`,
  as used by `cancellation-email.ts` (group `email_cancel`).

## Decisions
1. **Notifications are transactional** — the customer booked their own round — so
   they send via the raw providers with no marketing-consent/quiet-hours gate,
   matching the existing reminder. Fire-and-log: a send failure never fails the
   booking.
2. **One message per visit.** A multi-entry punch booking mints N bookings sharing
   round/date/customer; #10 notifies once (on the first). Reminder recipients are
   deduped by phone, so a parent with two kids gets one message (also a cost win).
3. **Editable copy.** All #10/#11 wording lives in the content registry (new group
   `booking_notify`), so Yanay edits it in "תוכן וטקסטים" with no deploy. The
   stay-duration reminder text stays hardcoded (untouched, out of scope).
4. **Configurable, cost-controlled.** New `round_settings`:
   `bookingConfirmEmail`/`bookingConfirmSms` (both default on) and
   `preVisitReminderOffsets` (default `[1440]` = 24h before start → "מחר"). Email
   is free; SMS is the paid channel and independently toggleable.

## Architecture
- **Schema** (migration `0035_organic_jane_foster.sql`, CLI-generated):
  - `round_reminder_log`: add `kind` enum (`stay`|`previsit`); unique key becomes
    `(round_instance_id, kind, offset_minutes)` so a pre-visit offset never
    collides with a stay-duration one.
  - `round_settings`: `pre_visit_reminder_offsets int[]`, `booking_confirm_email`,
    `booking_confirm_sms`.
- **DB** (`rounds-reminders.ts`): extracted `loadConfirmedRecipients` (SSOT, dedupe
  by phone), added `claimDuePreVisitReminders` (START-based, scans a date window
  bounded by the largest offset, claims under `kind='previsit'`). `round-settings.ts`
  validates the new fields (offsets 1–2880 min, ≤5).
- **API**:
  - `lib/booking-confirmation-notify.ts` — `fireBookingConfirmation` (mirrors
    `cancellation-email.ts`): loads details + settings + content, sends editable
    email/SMS. Hooked in `POST /rounds/book-punch` after a successful booking.
  - `lib/round-reminder-notify.ts` — added `firePreVisitReminder` (editable copy).
  - `routes/cron-rounds-reminders.ts` — the same per-minute cron now also claims +
    sends pre-visit reminders. No new Vercel cron schedule needed.
  - `routes/round-settings.ts` — admin PATCH accepts the three new fields.

## Security
No new endpoints. Cron stays behind the Bearer `CRON_SECRET` timing-safe check.
Copy is admin-only editable and rendered as text/HTML with escaping in email.
Walk-in sentinel phone is excluded from all sends.

## Observability
`[booking confirm]` (email/sms sent, provider error, threw) and
`[previsit reminder]`/`[round reminder]` (batch sent, counts). Cron logs
`preVisitBatches`/`preVisitSms` alongside the stay counts.

## Settings (rule 15)
`bookingConfirmEmail`, `bookingConfirmSms`, `preVisitReminderOffsets` live in
`round_settings`, editable via `PATCH /admin/round-settings`. The admin UI panel
for these still needs the three controls wired (API-editable now; defaults are
sensible so nothing is hardcoded).

## Cost (rule 8)
Both features add up to one paid SMS per booking (confirmation) and one per
booking (reminder) via Pulseem. Hebrew SMS is Unicode (~70 chars/segment); the
default bodies run ~2 segments. At scale this is a real line item — SMS is
toggleable per channel, and the reminder offset/copy are tunable. Pull live
Pulseem per-segment pricing before turning SMS on in production.

## Testing (rule 18)
- `rounds-reminders.test.ts`: pre-visit due 24h before start, idempotency, disable
  via empty offsets, kind-coexistence with a stay-duration row, and sibling
  dedupe. **9/9 pass.**
- `round-settings.test.ts`: new-field validation + persistence. **8/8 pass.**
- `rounds-booking.test.ts` (route, incl. #10 hook path in console-provider mode):
  **41/41 pass.**
- Registry integrity + content: **9/9 pass.** All three packages typecheck.
- Not unit-tested: the `fireBookingConfirmation` send itself (module-level
  provider singletons, no DI seam) — covered by typecheck + the route suite
  exercising the path. Needs a staging check against real Pulseem/Resend.

## Deploy
Branch `feat/wave2-staff-content`. Migration 0035 must run before the API deploy.
No push to `main`, standard PR flow. Rollback: the migration is additive
(`kind` defaults to `stay`); reverting the API code leaves the columns unused.

## Open / follow-ups
- Wire the three settings into the admin round-settings UI panel.
- Paid (WooCommerce) round bookings don't get #10 yet — only punch bookings do.
- "מחר" in the reminder SMS assumes the default 24h offset; if Yanay changes the
  offset he should edit the copy too (both are editable).
