# Pre-booking rules popup (in-app) — Yanay, 2026-07-17

## Goal
Yanay wants the "כמה דברים חשובים לפני ההזמנה" accordion popup he already runs on
the WordPress site to appear in the customer area too, firing every time a
customer registers for a round, so no one can claim they didn't know the venue
rules. Target: live for the Saturday-night (motzash) launch.

## Context / what already exists
- The customer app registers into rounds using **already-purchased punch cards**
  (`bookRoundWithPunch`) and via **reschedule/swap** (`swapRoundBooking`). Actual
  paid purchases still happen on the WP site, where Yanay's popup already runs.
  So in-app this gates the *booking* action, not a payment.
- The booking flow (`PunchRoundBooking`) already had a lighter version: an inline
  "כללי הכניסה" rules block + a mandatory "קראתי ואישרתי" checkbox gating confirm.
- All UI copy lives in the content registry (`packages/content`), admin-editable
  via the Wave 2 content editor. New strings = registry keys, no migration.

## Decisions (confirmed with Yoav)
1. **Trigger:** popup fires on the **final confirm** (booking) and on **choosing a
   swap target** (reschedule). On "הבנתי" it executes the booking/swap. The old
   inline rules block + accept checkbox in `PunchRoundBooking` are **removed**
   (redundant — the popup is now the single acknowledgment gate).
2. **Scope:** new bookings **and** reschedule both show the popup.

## What we are NOT doing
- Not porting the jQuery/Elementor snippet. It is WP-specific (Tabler icons,
  `elementorProFrontend.popup`, add-to-cart triggering) and irrelevant in React.
- Not rendering HTML from admin-editable copy (XSS surface). Section bodies are
  plain text with `\n` paragraph breaks + `whiteSpace: pre-line`, matching every
  other long string in the app. Tradeoff: the WP section-4 inline Instagram/Waze
  links become plain text. A single clickable "תקנון מלא" link stays in the
  footer (anchor, not from free text). Flagged to Yanay.

## Architecture
- **New component** `PreBookingInfoModal` in `CustomerApp.tsx` (the app keeps its
  components in this file; matching convention per house rule 2). Reused by both
  the booking and reschedule flows — single source, no duplication.
- Props: `onAcknowledge`, `onClose`. Pure presentational; the caller owns the
  pending action (book vs swap).
- Modal chrome mirrors the staff `SellerPinModal` pattern: fixed overlay, centered
  card, backdrop-click closes. Adds: internal scroll (mobile), 4-item accordion.

## Content keys (new group `customer_infopopup`)
`customer.infopopup.title`, `.s1|s2|s3|s4.{title,subtitle,body}` (12), `.continue`,
`.termsLink`, `.closeLabel`. Reuses existing `customer.bookflow.termsUrl` (SSOT for
the terms URL — no second copy). Group added to `ContentGroup` union + `CONTENT_GROUPS`;
the admin editor renders groups dynamically, so it auto-appears.

## Accessibility (house rule 16 + Israeli a11y)
`role="dialog"`, `aria-modal`, labelled by the title. Focus moves into the modal on
open and returns to the trigger on close. ESC + backdrop close. Body scroll locked
while open. Accordion heads are real buttons with `aria-expanded`.

## Observability (house rule 14)
`[customer rules-popup]` namespace: open (source: book|reschedule), toggle (section),
acknowledge, close. `console.info` with values.

## Settings audit (house rule 15)
All copy is admin-editable via the content editor (the settings surface for text).
Icons are fixed per section (not content) — intentionally not exposed. No new
toggles: "show every time" is the requirement, not a preference.

## Security
No new endpoints, no new data. Copy is admin-only editable and rendered as text
(no `dangerouslySetInnerHTML`). The terms link is a hardcoded anchor around an
editable URL — validate it stays `https://` in the existing content save path
(termsUrl already ships that way).

## Testing (house rule 18)
- Registry integrity test already covers new keys (unique, non-empty, placeholder
  match, known group) — runs in `packages/content`.
- New unit tests: `PreBookingInfoModal` renders all sections, accordion toggles,
  "הבנתי" fires `onAcknowledge`, backdrop/ESC fire `onClose` (not acknowledge).
- Booking-flow test: confirm click opens the modal and does not book until
  acknowledged; acknowledge triggers `bookRoundWithPunch`. Reschedule: choosing a
  target opens the modal; acknowledge triggers `swapRoundBooking`.

## Deploy
Feature branch `feat/wave2-staff-content` (current) or a new branch off it. No push
to `main`, no promote. Standard PR flow. This is customer-app + content-package
only; no API/DB change, so no server deploy needed for the copy to work (defaults
ship in the bundle; overrides via the existing /content path).

## Open questions
- Section-4 parking links going plain-text acceptable? (default yes for launch)
- Reschedule copy: same 4 sections as booking, or a trimmed set? (default: same)
