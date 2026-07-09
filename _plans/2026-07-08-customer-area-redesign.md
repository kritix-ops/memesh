# Customer area redesign — "ממש" (my.memesh.co.il)

Date: 2026-07-08
Origin: Yanay's design brief (`memesh-customer-area-brief.md`) + 3 mockups + WhatsApp ("same functionality, just different design and layout"). Council skipped per the standing note on Yanay-originated asks.
Owner: Yoav. Product: Yanay.

## The one-line truth

This is a **frontend re-skin of the existing `apps/customer` React SPA**, not a new build. Yanay said it himself: *"אותה פונקציונליות רק עיצוב וסדר שונה."* The functionality — including "book a round from an existing punch card," which he specifically called out — is already built and live. The work is layout, navigation, filters, and the design system.

## Current state (verified against code, not the brief)

- **Auth:** phone + OTP, cookie/JWT (`requireCustomer`). Login screen exists (`CustomerLogin`).
- **Endpoints already wired & working:** `/me` (profile), `/me/cards` (punch cards), `/rounds/my-bookings`, `/rounds/book-punch` (**= the brief's "NEW" `POST /rounds/hold/punch-card`**), `/rounds/cancel`, `/rounds/swap`, `/rounds/companion/checkout`, `/rounds/availability(-range)`, `/rounds/waitlist/*`.
- **UI today:** one 2,243-line `CustomerApp.tsx` — a single stacked `Home` (profile summary + bookings + cards + book-from-card picker + waitlist) plus a separate `profile` screen. Components already built and hardened: `CustomerLogin`, `Home`, `PunchRoundBooking` (the book-from-card picker + `MonthCalendar`), `RoundBookingCard` (cancel/swap/companion pay), `WaitlistEntryCard`, `ProfileEdit`.
- **Design system:** Ploni `@font-face` is already declared in `index.css` (light/regular/bold) — it only needs the `.woff2` files dropped into `public/fonts`.

## Backend: essentially nothing new for v1

Every backend item in the brief's checklist already exists under a different route name (`/me/bookings`→`/rounds/my-bookings`, `/me/punch-cards`→`/me/cards`, `DELETE /bookings/:id`→`POST /rounds/cancel`, `hold/punch-card`→`book-punch`). **Do not build the duplicate `/rounds/hold/punch-card`.** Also correct the brief's model: an entry is **spent at booking time and returned on cancel** (no oversell), not "punched at entry" — the shipped upcoming-reservation copy already reflects this.

Genuine data gaps (each optional / deferrable — see Open Questions):
- **Child filter** (brief §4): bookings have **no child association at all** in the schema → this is a non-trivial new feature (schema + booking flow), NOT frontend. **Deferred from v1.**
- **Card filter** (by serial): `/rounds/my-bookings` doesn't return `punchCardId` → a one-field additive backend change if we want it, else defer.
- **Per-card entry history** (brief lists `GET /me/punch-cards/:id/entries`): no customer endpoint today → small additive route if the cards screen needs a history list (the dots viz alone doesn't).

## Scope

**In (v1):** 3-screen shell with navigation (desktop sidebar 148px + mobile bottom-nav, 768px breakpoint); collapsible cards (first open with QR, rest summarized); bookings filter system (status segmented `קרובות/עבר/בוטלו/הכל` + period chips + type chips); punch-card dots visualization (12-grid); "הזמנת סבב" button on the cards screen → the existing picker; linked-booking badge on a card; full design system (tokens, Ploni, no emojis, RTL, 44×44 targets, 16px inputs, radii); per-screen loading/empty/error states.

**Out (v1):** child filter (deferred — no data); card-serial filter + entry history (optional adds, decide later); WebSocket real-time (polling stays, per brief §9); any WooCommerce/gift-flow redesign (`CheckoutComplete`/`GiftClaim` untouched); SSO/embedding changes.

## Approach — alternatives (rule 4)

- **Option A — restructure in place (recommended).** Break `CustomerApp.tsx` into `screens/` + `components/` + an `AppShell` (nav + screen router), migrate the existing hardened components (`RoundBookingCard`, `PunchRoundBooking`, `ProfileEdit`) into the three screens, then layer the design system. *Pros:* preserves the battle-tested booking/cancel/swap/companion/waitlist logic (lots of edge cases already handled); lowest regression risk; incremental and reviewable. *Cons:* carries some legacy code shape during the transition.
- **Option B — rebuild fresh.** New shell, rewrite components against the same endpoints. *Pros:* cleanest architecture. *Cons:* throws away working logic, high regression risk on money/booking paths, slow. Rejected.
- **Option C — minimal nav split.** Just add nav + split screens, skip filters/dots/polish. *Pros:* fast. *Cons:* doesn't meet the brief. Rejected.

**Recommendation: A** — it is the literal implementation of "same functionality, new design."

## Phased build (each independently reviewable)

1. **Shell + nav + tokens.** `AppShell`: desktop sidebar (148px, item counts, logout) / mobile bottom-nav; screen router (`הזמנות | כרטיסיות | פרופיל`); design tokens module (colors/radii/spacing) + confirm Ploni loads. Move existing content into the 3 screens as-is (function first, style next).
2. **הזמנות screen.** Collapsible booking cards (first open → QR + שנה שעה/ביטול; rest → date+time+chevron); status segmented control + period/type chips (client-side, over `/rounds/my-bookings`); reuse `RoundBookingCard` internals.
3. **כרטיסיות screen.** Collapsible card cards; 12-dot grid viz; "הזמנת סבב" → existing `PunchRoundBooking`; linked-booking badge (from `my-bookings` where `source==='punchcard'`).
4. **פרופיל screen.** `ProfileEdit` into the new layout: read-only phone (lock + "פנו לצוות לשינוי"), channel button group, children editor.
5. **Polish + QA.** Per-screen loading/empty/error; responsive pass at 768px; a11y (44px hit areas, focus, 16px inputs); strip any emojis; **RTL bidi audit** (year+number adjacency — the "ינואר 20265" class of bug — verify every date/count).

## Security (rule 13)
No new attack surface — reuse `requireCustomer`-gated endpoints. Phone stays read-only (identifier). No secrets client-side; no PII in logs. Customer only ever sees their own data (server-scoped).

## Observability (rule 14)
Namespaced `console.info` per screen/action, matching the existing `[customer …]` logs: `[customer nav] switch`, `[customer bookings] filter`, `[customer card] book-round`, `[customer profile] save`, with the actual values.

## Testing (rule 18)
- Pure logic → `node:test` units: filter predicates (status/period/type), dots computation, booking grouping/sort. Same style as `schedule-rules-group.test.ts`.
- Component flows are thin over already-tested endpoints → manual QA matrix per screen (golden / empty / error / mobile+desktop). Keep the existing customer suite green.
- A regression checklist for the migrated logic: cancel (24h rule), swap, companion pay, waitlist join/leave, book-from-card count.

## Settings (rule 15)
No new venue settings. Customer-facing "ערוץ עדכונים" (mail/whatsapp/sms) already exists in profile; keep it. Nothing to add.

## Deploy (rule 19)
`apps/customer` is its own Vercel project (`memesh-customer`). Feature branch → PR → `main`; no backend/migration, so no cross-project deploy ordering. Verify against the production API. If/when this replaces the WP PHP customer area, that's a separate cutover (routing/SSO) — out of scope here.

## Open questions (O)

- **O1 — replace or coexist?** Does this go live as `my.memesh.co.il` replacing the WP `memesh-customer-area` now, or run alongside first? Affects the embedding/SSO work in brief §9 (out of v1 scope either way, but sequencing matters).
- **O2 — child filter:** confirm it's deferred. Wiring it needs a booking↔child link that doesn't exist (schema + booking-creation change across paid + punch + WC flows). Recommend a separate project.
- **O3 — card-serial filter + per-card entry history:** want them in v1? Each is a small additive backend change (`punchCardId` on `my-bookings`; a `/me/cards/:id/entries` route). Cheap, but not required for the core redesign.
- **O4 — Ploni woff2 files:** drop the licensed files into `apps/customer/public/fonts` (names already referenced in `index.css`), or fetch from the WP-hosted URLs in the brief? Prefer self-hosting in the app.
