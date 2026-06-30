---
title: POS sell — prompt to mark entrance(s) immediately after a card sale
date: 2026-06-25
status: in-progress
owner: Yoav
decider: brother (product owner)
branch: feat/email-copy-editable-rtl
depends_on:
  - apps/staff Sell flow (shipped) — `Sell` component in apps/staff/src/pos/PosApp.tsx
  - apps/staff PunchConfirmModal styling + entries-picker UX (shipped)
  - apps/api POST /punch (shipped) — accepts serial + idempotencyKey
---

# POS sell — prompt to mark entrance(s) immediately after a card sale

## Goal in one sentence

When a cashier creates a punch card at the POS, the success step pauses to ask
"are they entering now, and how many?" with no pre-selected default, so the
common case (buy + walk in) collapses to one extra tap instead of a second
scan a minute later.

## Why this is worth doing

Yoav's quote, 2026-06-25:

> When customers buy a כרטיסייה manually from the cashier (not online), it
> should pop the cashier with a question whether to mark an entrance already,
> and how many entrances — because otherwise it slows down a little. Usually
> when they buy one they immediately also want to get in.

Today's flow after a successful POS sell:

1. Cashier creates the card → success screen shows QR + serial + two buttons
   ("to customer card" / "back to main").
2. Customer walks toward the entrance.
3. Cashier opens Scan, scans the QR, picks entries, confirms.

That second scan is pure ceremony for the common case. We already know who
the card is for, we already know the card has full entries, and we already
have a cashier session attached. Pulling the punch into the same success
step removes a ~10 second loop and keeps the queue moving on Saturday
mornings.

## Constraints

- **No default.** The cashier must pick. Per the conversation, the worst
  failure mode is the system silently consuming an entry the customer did
  not actually intend. "No default — must pick" is the explicit user choice.
- **Skipping is a first-class option.** Some buyers genuinely are not
  entering yet (grandparents buying as a gift, parents on their way out).
  "Don't punch" sits next to "1" / "2" / "custom" and is not buried.
- **Must respect remaining entries.** Custom can never exceed the card's
  totalEntries (12 for the standard card). Server caps again as a backstop.
- **Idempotent.** A second tap on the same choice must not double-punch.
  Generate a new UUID once per prompt mount; reuse on retry.
- **Same audit trail as a normal punch.** The server records method='manual'
  with the sellerId attached so reports show "this entry was marked at the
  moment of sale by cashier X."
- **No new server endpoint.** Reuse `POST /punch` via
  `punchBySerial(serial, { entries, idempotencyKey })` — same call the
  Customer detail flow uses today.
- **Cannot regress the no-inner-components guard** in
  `PosApp-no-inner-components.test.ts` — the new UI lives at module scope.

## Alternatives considered

### A. New intermediate step `sellStep: 'mark-entry'` (RECOMMENDED — chosen)

Slot a new phase between `'confirm'` (sale succeeded) and `'done'` (QR +
nav). The mark-entry step shows the four explicit choices; after the
cashier picks, we either run the punch and then go to `'done'`, or go to
`'done'` directly if they picked 0.

- **Pros:** clean state machine, no clutter on the QR success screen, an
  obvious moment for an active decision, easy to A/B disable behind a flag
  later by skipping the step.
- **Cons:** one extra screen even when the cashier wants to skip.

### B. Inline prompt on the existing `'done'` screen

Add a banner above the QR with the four buttons; "back to main" stays
disabled until the cashier picks one.

- **Pros:** no new state.
- **Cons:** visual clutter, two competing primary actions on the same screen
  (the QR vs the prompt), and disabling "back to main" feels hostile.

### C. Skip the prompt entirely; auto-punch 1 on POS sale

Trust the common case and quietly consume 1 entry as part of the sale.

- **Pros:** literally zero taps.
- **Cons:** silently mutates entries when the customer is not entering yet
  (gifts, "I'll come tomorrow") — the exact failure mode the user flagged
  ("must pick").

**Going with A.**

## UX details

### Trigger
After `executeSell` resolves with `ok: true`, set `sellStep = 'mark-entry'`
instead of jumping straight to `'done'`.

### Layout (Hebrew, RTL)
- Heading: `"כניסה עכשיו?"` (one beat — match the brief, plain language).
- Subline: `"בחרו כמה כניסות לנקב כעת, או דלגו."` — sets the lazy-user
  expectation that skipping is fine.
- Four equal-weight choice tiles (2x2 on mobile, 1x4 on wider):
  - `"בלי כניסה כעת"` — sets state to skip; advances to `'done'`.
  - `"כניסה אחת"` — calls punch with entries=1.
  - `"שתי כניסות"` — calls punch with entries=2.
  - `"כמות אחרת"` — reveals the +/- picker (1..totalEntries) and a small
    "סמן N כניסות" confirm button.
- None of the four are pre-selected, none are highlighted as primary.
- During the punch network call, show `"מסמן…"` on the chosen tile and
  disable the others.
- On punch error, surface a Hebrew message via the existing
  `humanizePunchError` helper, show a "נסו שוב" button next to "דלג ועברו
  להמשך". Errors that are not retryable (`exhausted` — vanishingly unlikely
  on a brand-new 12-entry card, but possible if totalEntries was overridden)
  collapse the picker and show "המשך".

### On `'done'`
If the cashier just punched N at the mark-entry step, show a small green
chip above the QR: `"✓ נוקבו N כניסות בעת המכירה · נותרו M"`. Otherwise
nothing changes — same QR, same buttons.

### Lazy-user check
- The cashier never has to remember to punch.
- A new cashier sees four obvious choices and picks one; no hidden menus.
- Skipping is one tap; the dominant case (1 entry) is one tap.
- The success screen tells them what just happened ("נוקבו 1 כניסה").

## State changes (apps/staff)

- `sellStep` union gains `'mark-entry'`.
- New state in PosApp:
  - `markEntryCount: number | null` — the choice committed at mark-entry
    (null when skipped or not yet picked).
  - `markEntryPunching: boolean`.
  - `markEntryError: string | null`.
  - `markEntryKey: string` — fresh UUID on entering the mark-entry step,
    reused for idempotent retry.
  - `markEntryRemaining: number | null` — set from punch response so the
    'done' chip can show "נותרו M".
- New module-scope component `apps/staff/src/pos/MarkEntryAtSale.tsx` —
  pure UI; receives the four handlers, the card serial for the picker
  ceiling, submitting/error state, and the +/- picker substate.
- Modify `Sell()` in `PosApp.tsx`:
  - Render `<MarkEntryAtSale … />` when `sellStep === 'mark-entry'`.
  - On `'done'`, show the success chip when `markEntryCount > 0`.
- Modify PosApp orchestrator:
  - `executeSell` success path → `setSellStep('mark-entry')` and
    `setMarkEntryKey(crypto.randomUUID())`.
  - Handlers `onSkipMarkEntry`, `onConfirmMarkEntry(n)` — the latter calls
    `punchBySerial(serial, { entries: n, idempotencyKey: markEntryKey })`.
  - On `sellNewForSelectedCustomer` + close handlers, reset mark-entry
    state alongside `sellResponse`.

No changes to the API. No changes to settings (yet — see below).

## Security

- Punch authorization already enforced by the API (signed-in staff +
  permission check). The new flow does not bypass anything; it just calls
  the same endpoint earlier.
- Idempotency key prevents double-punch on retries / double-clicks.
- No new PII exposed; the UI shows the same data the QR screen already does.
- Cashier attribution: the punch is attributed to the signed-in user, same
  as a regular scan-and-punch.

## Observability

All logs follow the existing `[pos sell]` / `[web punch]` namespace pattern.

- `console.info('[pos sell] mark-entry shown', { serial, totalEntries })` —
  on entering the step.
- `console.info('[pos sell] mark-entry skip', { serial })`.
- `console.info('[pos sell] mark-entry submit', { serial, entries })`.
- `console.info('[pos sell] mark-entry success', { serial, entries, remaining, replay })`.
- `console.warn('[pos sell] mark-entry error', { serial, status, error })`.

These mirror the existing `[web punch]` logs so a single grep tells the
full story of an entry, whether punched at sale or at scan time.

## Settings audit (rule 15)

Considered new settings; landing only the minimum needed.

- **NOT exposed (yet):** an on/off toggle for the prompt itself.
  - Rationale: the user's stated intent is universal ("always prompt").
    Adding a toggle now creates a setting that no one will flip and a UI
    surface that needs to be tested. If a future operator wants the old
    behavior back, we add `promptMarkEntryAfterCardSale: boolean` to
    `PosSellControls` and gate the step. One-line change at that point.
- **NOT exposed:** a default value (1 / 0 / etc).
  - Rationale: explicit user requirement is "no default — must pick."
    A configurable default would defeat that.
- **NOT exposed:** the quick-pick set (`[1, 2]`).
  - Rationale: the standard card is 12 entries and the realistic same-visit
    case is 1 or 2 (child + companion). "כמות אחרת" handles the long tail
    (3 cousins visiting). Making the quick picks editable adds zero value.

Recommendation: revisit only if a real operator asks.

## Testing (rule 18)

Test infra available in apps/staff: `node --test --import tsx` over plain
TS files. No React renderer is wired, so component-level tests are out;
source-structure guards and pure-helper unit tests are in.

### New tests
- `apps/staff/src/pos/MarkEntryAtSale.test.ts` — pure logic:
  - Custom-amount picker clamps to [1, totalEntries].
  - The "skip" path returns `entries === 0` and never invokes the punch
    callback (passed-in stub asserts not called).
  - The "1 / 2" tiles dispatch the right entries value.
  - Initial state has no selection (`pickedTile === null`) so the test
    documents the "no default" requirement.
- Extend `apps/staff/src/pos/PosApp-no-inner-components.test.ts` only if
  the new state lands inline (it won't — `MarkEntryAtSale` is module
  scope, so the existing guard already covers it).

### Manual QA pass (rule 6)
- Sell + tap "כניסה אחת" → success chip shows "נוקבו 1 · נותרו 11", QR
  visible.
- Sell + tap "שתי כניסות" → chip shows 2 / נותרו 10.
- Sell + "כמות אחרת" → +/- picker, increment to 3 → confirm → chip 3 / נותרו 9.
- Sell + "בלי כניסה כעת" → straight to QR, no chip.
- Punch network error → red banner with retry, second tap reuses idempotency
  key (no double-punch on server).
- Double-tap "כניסה אחת" while the request is in flight → no second call,
  no double punch.
- "חזרה" while on mark-entry → resets sell state, no orphaned mark-entry
  state when opening Sell next time.
- Browser refresh on mark-entry → no recovery (acceptable, since the card
  is created and scan flow still works to punch it later).

## Deploy

- Branch is `feat/email-copy-editable-rtl`, already carrying two unrelated
  edits (SMS-aware success copy in `Sell` + the matching response field in
  `cards.ts`). Both are small and complementary.
- Plan: commit this work as a separate commit on the same branch, push,
  open a PR into `main`, manual review, merge → auto-deploy to Vercel
  preview, smoke test, then promote per the project's normal flow.
- **Will touch:** `apps/staff/src/pos/PosApp.tsx`,
  `apps/staff/src/pos/MarkEntryAtSale.tsx` (new), `apps/staff/src/pos/`
  test file (new), `apps/staff/src/lib/api/punch.ts` only if I need to
  expose a new option (probably not).
- **Will NOT touch:** `main`, `apps/api/*`, any settings table, any DB
  schema, any other app. No env-var changes. No production promotion.
- **Rollback path:** revert the commit on the branch; the existing flow is
  unchanged anywhere except the new state branch. If only the new step
  needs disabling without a full revert, a one-line change in `executeSell`
  to skip `'mark-entry'` and go straight to `'done'` neutralizes the
  feature without touching the new component.

## Open questions

- None blocking. The user has already answered the two scope questions
  (implement now; no default).
