# Expanded הגדרות — cover every card scenario, sub-nav layout

**Status:** approved 2026-06-19 (Yoav).

## Goal

Take the single-screen "הגדרות כרטיסייה" we just shipped and grow it into a
real settings surface that controls every card-related operational scenario
the cashier or admin would ever want to change without a code deploy.

Re-design from one form into a sectioned screen with a left sub-nav.

## Locked decisions (2026-06-19)

| Question | Answer |
|---|---|
| Scope groups | Card mechanics + Cancellation & refunds + SMS & reminders + Operational UX + customer registration |
| Layout | Sub-nav inside the הגדרות tab — each section is its own screen |
| Save model | Per-section save |
| Multi-tier packages / loyalty | **Out of scope** — pure speculation, no existing feature |

## Brutally honest scope cut

The "SMS & reminders" group as I originally pitched it would expose knobs for
features that don't exist yet (no cron job, no scheduled task infrastructure).
That violates "no half-finished implementations" — a gray knob for "send
expiry reminder in 30 days" backed by nothing is worse than no knob at all.

What I'm doing instead:

- **Build for real** (the knob does something today):
  - SMS on card purchase
  - SMS on low entries (sent inside the punch handler when remaining ≤ threshold)
  - Quiet hours (applied to non-OTP sends only — OTP must bypass because users actively requested the code)
- **Defer** (would need cron / scheduled jobs):
  - Expiry reminder N days before
  - Birthday SMS
  - Dormant re-engagement
  Not on the screen until the cron infra lands. Will be its own plan.

## Sections (5 total)

### 1. כרטיסייה (existing, renamed)
Already shipped. Same fields: price, validity days, total entries, pitch label.

### 2. כללי כרטיסייה (Card mechanics)
- `minCompanions` — min companions per punch (today hardcoded 1). Range 1–10.
- `maxCompanions` — max companions per punch (today hardcoded 4). Range 1–10, must be ≥ min.
- `sameDayLockoutMinutes` — cool-off window after a punch before another punch on the same card is accepted. Default 0 (no lockout). Range 0–1440 (24h). Server enforces; cashier sees a Hebrew message.
- `gracePeriodDays` — extra days past `expiresAt` where the card still works but `scanCardLookup` and the modal show a yellow "מעבר לתוקף" warning. Default 0 (hard expiry).

### 3. ביטולים והחזרים (Cancellation & refunds)
- `allowCancelAfterFirstPunch` — bool, default `true`. When false, cards with usedEntries > 0 cannot be cancelled (cashier sees a clear message).
- `minCancelReasonLength` — int, default 5 (today 1). Range 1–500.
- `refundPolicyText` — free-form text shown on the cancel modal so the cashier reads the same line to every customer. Max 2000 chars.
- `cancelRole` — `'admin'` (admin only) or `'manager'` (admin + manager, today's behavior). Default `'manager'`.

### 4. הודעות SMS (Communication)
- `smsOnPurchase` — bool, default `true`. Sends a "כרטיסייה חדשה ב-Memesh" SMS with the card's serial + a /me link after a successful sale.
- `smsLowEntriesThreshold` — int, default 0 (off). When > 0 and a punch leaves `remaining ≤ threshold`, sends "נותרו N כניסות בכרטיסייה שלכם".
- `smsQuietHoursStartMinutes` — int 0–1439, default `21 * 60`. Display as HH:MM in the UI.
- `smsQuietHoursEndMinutes` — int 0–1439, default `9 * 60`. Display as HH:MM in the UI.
- Quiet hours apply to non-OTP sends only. The SMS abstraction grows a `priority: 'transactional' | 'marketing'` flag — `'transactional'` (OTP) bypasses; `'marketing'` (purchase/low-entries) respects.
- All marketing sends still require `customer.marketingConsentAt != null` (existing legal gate).

### 5. חוויית קופה ולקוחות (Operational UX + customer registration)
- `expiryBadgeThresholdDays` — int, default 14 (0 = off). When the active card expires within N days, customer detail + scan preview show a yellow "פג בקרוב" badge.
- `requirePunchConfirmation` — bool, default `false`. When true, even the customer-detail "ניקוב כניסה" goes through the modal (today: the modal already shows for companion count, but a future single-tap punch flag could land here).
- `requireEmailOnNewCustomer` — bool, default `false`. When true, email becomes required in the new-customer form (today: optional + 'recommended').
- `requireChildOnNewCustomer` — bool, default `false`. When true, ≥1 child row required.

## Backend changes

### Migration (`packages/db/migrations/0002_expanded_card_settings.sql`)

```sql
ALTER TABLE card_settings
  ADD COLUMN min_companions               integer NOT NULL DEFAULT 1,
  ADD COLUMN max_companions               integer NOT NULL DEFAULT 4,
  ADD COLUMN same_day_lockout_minutes     integer NOT NULL DEFAULT 0,
  ADD COLUMN grace_period_days            integer NOT NULL DEFAULT 0,
  ADD COLUMN allow_cancel_after_first_punch boolean NOT NULL DEFAULT true,
  ADD COLUMN min_cancel_reason_length     integer NOT NULL DEFAULT 5,
  ADD COLUMN refund_policy_text           text    NOT NULL DEFAULT '',
  ADD COLUMN cancel_role                  varchar(16) NOT NULL DEFAULT 'manager',
  ADD COLUMN sms_on_purchase              boolean NOT NULL DEFAULT true,
  ADD COLUMN sms_low_entries_threshold    integer NOT NULL DEFAULT 0,
  ADD COLUMN sms_quiet_start_minutes      integer NOT NULL DEFAULT 1260,
  ADD COLUMN sms_quiet_end_minutes        integer NOT NULL DEFAULT 540,
  ADD COLUMN expiry_badge_threshold_days  integer NOT NULL DEFAULT 14,
  ADD COLUMN require_punch_confirmation   boolean NOT NULL DEFAULT false,
  ADD COLUMN require_email_on_new_customer boolean NOT NULL DEFAULT false,
  ADD COLUMN require_child_on_new_customer boolean NOT NULL DEFAULT false;
```

### Behavior wiring (what each new setting actually does)

| Setting | Code change |
|---|---|
| `min/maxCompanions` | `POST /punch` reads settings, rejects out-of-range with 400 `companions_out_of_range`. Frontend modal `+/-` buttons clamp to the configured range. |
| `sameDayLockoutMinutes` | `punchCard` checks the last entry's `punchedAt`; if `now - lastPunchedAt < lockout`, returns `{ok:false, reason:'locked_out', retryAfterMinutes}`. |
| `gracePeriodDays` | `scanCardLookup` widens 'ok' window by N days; adds `'grace'` status (yellow banner). `punchCard` accepts during grace. |
| `allowCancelAfterFirstPunch` | `cancelCard` reads settings, refuses if `usedEntries > 0` and the flag is false. Returns `{ok:false, reason:'cancel_blocked_after_punch'}`. |
| `minCancelReasonLength` | `cancelBodySchema` becomes a transform that validates length at handler time against settings. |
| `refundPolicyText` | Returned by `/admin/cards/list` route or a new dedicated endpoint? Simpler: returned in the GET /admin/card-settings/cancel-context endpoint that the cancel modal fetches lazily. |
| `cancelRole` | The `/cards/:id/cancel` preHandler becomes a custom hook that reads settings and decides allowed roles per request. |
| `smsOnPurchase` | `POST /cards` (sale) hook fires `sendMarketingSms({ priority:'marketing', body:'...' })` if flag + consent. Failures are logged, not raised — sale must not fail because SMS fails. |
| `smsLowEntriesThreshold` | `punchCard` (after a successful punch) checks `remaining ≤ threshold && threshold > 0 && consent`, fires marketing SMS. |
| `sms quiet hours` | New `sendMarketingSms` wrapper in `apps/api/src/lib/sms.ts` — if current local time (Israel/Jerusalem) is inside the quiet window, queue is deferred; for now we **drop** (log it and skip), since there's no queue yet. Flag in plan as a future-cron upgrade. |
| `expiryBadgeThresholdDays` | New field in `scanCardLookup` response: `expiresInDays`. Frontend shows yellow badge if positive and ≤ threshold. |
| `requirePunchConfirmation` | Surfaced in the customer detail screen — today the modal always shows, so this is a no-op until a "single-tap punch" flag is wired. Mark as "reserved" in the plan; UI shows the toggle but does nothing yet → drop or keep? **Drop until the single-tap flow is built.** Don't expose a dead knob. |
| `requireEmailOnNewCustomer` | `/customers POST` validates server-side. Frontend form changes the 'recommended' badge to a required asterisk based on `/pos/customer-form-rules` (new endpoint returning the two booleans). |
| `requireChildOnNewCustomer` | Same. |

**Reserved/dropped**: `requirePunchConfirmation` is excluded from the section
since the underlying single-tap flow doesn't exist — adding the toggle would
ship a dead knob.

### API surface additions

- Existing: `GET /admin/card-settings`, `PATCH /admin/card-settings`, `GET /pos/card-pricing`.
- New: `GET /pos/customer-form-rules` (returns `{ requireEmail, requireChild }`) — for the new-customer form. Cashier+.
- New: `GET /pos/cancel-context` (returns `{ refundPolicyText, minCancelReasonLength, allowAfterPunch }`) — for the cancel modal. Manager+.
- The cancel route's preHandler becomes settings-aware.

### New shared util

- `formatHHMM(minutes: number)` and `parseHHMM(string)` in the frontend api client or a shared util. Both used by the SMS quiet-hours fields.

## Frontend

### Sub-nav layout

`Settings()` becomes a router:

```
┌──────────────────┬─────────────────────────────┐
│ הגדרות           │                             │
│ ─────            │      <selected section>     │
│ • כרטיסייה      │                             │
│   כללי כרטיסייה │                             │
│   ביטולים        │                             │
│   הודעות SMS    │                             │
│   חוויית קופה   │                             │
│   ולקוחות       │                             │
└──────────────────┴─────────────────────────────┘
```

Sub-nav lives only inside the `view === 'settings'` branch; the outer admin
nav is unchanged. Mobile: sub-nav stacks horizontally above content.

### Per-section save

Each section is its own component with:
- Its own `useState` for the form.
- Its own `dirty` check vs the loaded row.
- Its own `[שמור]` button (disabled if not dirty or submitting).
- Its own inline success flash + top-error banner.

Reuses the existing `updateCardSettings(patch)` — patch only includes that section's fields. The server's `updateCardSettings` already short-circuits no-changes per field, so no audit-log spam.

### Files

- `apps/web/src/admin/settings/` — new folder, one file per section + a router:
  - `Settings.tsx` — sub-nav + section router.
  - `CardSection.tsx` — existing card pricing fields.
  - `MechanicsSection.tsx` — min/max companions, lockout, grace.
  - `CancellationSection.tsx` — toggles + refund policy text + role select.
  - `SmsSection.tsx` — purchase toggle, low-entries threshold, quiet hours.
  - `OperationalSection.tsx` — expiry badge threshold, customer registration toggles.
  - `shared.tsx` — common styles, NumberField, BooleanField, TimeField, TextAreaField.

The current inline `Settings()` in `AdminApp.tsx` is removed and replaced with `import { Settings } from './settings/Settings'`.

### Old screen migration

The existing card-pricing form is moved verbatim into `CardSection.tsx`. No
breakage — just relocated.

## Tests

### db
- New settings columns roundtrip (get + update + diff).
- Range validation for every new int field.
- `cancelRole` accepts only 'admin' or 'manager'.
- Migration applies cleanly on fresh pglite.

### Behavior tests in existing modules
- `punchCard` enforces `sameDayLockoutMinutes`.
- `cancelCard` enforces `allowCancelAfterFirstPunch` and `minCancelReasonLength`.
- `scanCardLookup` returns `'grace'` status during the grace period.
- `createPunchCard` flow: after a sale, an SMS-on-purchase is attempted iff flag + consent.

### Frontend api client tests
- `getCustomerFormRules` returns the booleans.
- `getCancelContext` returns the trio.

## Observability

- `[card-settings update]` already logs diffs — extends automatically to new fields.
- `[punch lockout]` when a punch is rejected due to lockout, with `{ retryAfterMinutes }`.
- `[punch grace]` when a punch is accepted in grace period.
- `[sms purchase]` and `[sms low-entries]` on attempted marketing sends with `{ skipped: 'quiet-hours' | 'no-consent' | 'disabled' }` or `{ sent: true }`.
- `[cancel blocked]` when a cancel is refused due to `allowCancelAfterFirstPunch`.

## Security

- All new settings are admin-only on write (existing `requireRoleHook('admin')`).
- Range validation server-side (zod schemas + DB).
- Customer-facing settings (`refundPolicyText`) are server-rendered, not eval'd; max 2000 chars; HTML neutralized (we just render text, no `dangerouslySetInnerHTML`).
- Quiet hours / consent enforcement happens server-side — frontend toggle is UX only.

## Migration risk

The new ALTER TABLE adds 16 columns with defaults to a row that already has
exactly 1 entry. Cost is constant, zero downtime on Neon, no read locks beyond
the brief ALTER. Production deploy = `git push` + auto-migrate-on-prod runs
the migration before serving requests on the new bundle.

## Out of scope (documented for future planning)

- Expiry reminder SMS (needs cron).
- Birthday SMS to children (needs cron).
- Dormant re-engagement SMS (needs cron).
- Single-tap punch flow + `requirePunchConfirmation` toggle.
- Multiple card tiers (6/12/24 entries).
- Loyalty bonuses.
- AccuPOS-driven sale integration (will inform `smsOnPurchase` send-site).
