# Gift card checkout (כרטיסיית מתנה)

**Date:** 2026-06-24
**Author:** Claude (Opus 4.7) for Yoav (Flexelent)
**Status:** Draft — awaiting Yoav's approval before implementation.
**Builds on:**
- WC webhook integration (2026-06-20, commit `4bab90a` era)
- WC post-purchase SMS (2026-06-22, commit `70e0dd2`)
- Post-purchase email via Pulseem (2026-06-23, commit `529e986`)
- Admin-editable email copy + RTL fix + logo (2026-06-24, commit `dd80d36`)

## Goal

Let a buyer purchase a punch card as a gift for someone else at WC checkout.
The recipient receives an email about the gift; if they are already a Memesh
customer, the card lands in their account automatically; if not, they claim
the gift via a magic link (which creates their customer record on first
use). The buyer also receives a confirmation email.

## Scope locked with Yanay (WhatsApp, 2026-06-24)

| Question | Decision |
|---|---|
| Delivery channel | Email only (no SMS for gifts in v1) |
| Recipient already a customer? | Auto-add to their account, send "you got a gift" email |
| Recipient not a customer? | Pending-claim model — pending row + claim-link email |
| Personal message field | Out of scope v1 |
| Scheduled future delivery | Out of scope v1 |
| Logo | Reuses existing `og-image.png` (already swapped to Memesh logo in commit `dd80d36`) |
| Email language + direction | Hebrew, RTL, right-aligned text |
| Claim TTL | 365 days (admin-editable via `giftClaimTtlDays`) |
| Feature toggle | `giftCardsEnabled` defaults **ON**; exists as kill-switch only |
| Buyer-consent checkbox at WC | Not adding (per Yoav 2026-06-24) — email's lower legal exposure makes this acceptable risk |
| Notify buyer when recipient claims | Yes, default ON, admin-toggleable |
| Refund / cancel UX | Deferred to v2 — admin handles refunds manually via WC for v1 |
| Mixed carts (gift + self-purchase) | Blocked in v1 — WC plugin enforces "whole order is gift OR nothing is" |

## Why pending-claim instead of auto-create-customer

Two genuine designs were considered:

- **Model A — Auto-create the recipient customer at order time.**
  Smaller engineering footprint (reuses `resolveOrCreateCustomerFromWc`),
  zero friction at claim. But it silently stores a stranger's PII in our
  DB without their consent, orphans rows when the buyer typoes the
  recipient's email, and creates ambiguity when the recipient eventually
  signs up themselves.

- **Model B — Pending claim (chosen).**
  No recipient customer row is created at order time. A `gift_pending_claims`
  row holds the recipient's details + a single-use claim token. The
  recipient must click the email link and verify (phone OTP) before the
  card and customer are created. Matches Yanay's WhatsApp wording exactly
  (*"הוא יכול ללחוץ על לינק ליצירת חשבון וקבלת המתנה"*). Slightly more
  work (~half a day), but it is the right privacy posture and surfaces
  typoed emails as visible "unclaimed gifts" instead of silent orphans.

The hybrid case — recipient is already an existing customer — short-circuits
to direct-mint, which gives that path the zero-friction UX of Model A
without the consent question (the recipient is already in our system).

## Architecture

```
┌──────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
│ WC plugin writes │    │ POST /webhooks/      │    │ processWcOrder      │
│ gift meta_data   │───▶│ woocommerce/order    │───▶│ Webhook (existing)  │
│ on the order     │    │ (HMAC verified)      │    │ + gift branch (NEW) │
└──────────────────┘    └──────────────────────┘    └──────────┬──────────┘
                                                                │
                                  ┌─────────────────────────────┴───────────┐
                                  │ recipient phone OR email matches an     │
                                  │ existing customer?                       │
                                  └────────┬──────────────────┬─────────────┘
                                       YES│                  │NO
                                           ▼                  ▼
                          ┌────────────────────────┐  ┌────────────────────────┐
                          │ createPunchCard with   │  │ insert gift_pending_   │
                          │ is_gift=true, gift_*   │  │ claims row + claim     │
                          │ buyer fields           │  │ token                  │
                          └───────────┬────────────┘  └───────────┬────────────┘
                                      │                            │
                                      ▼                            ▼
                          ┌────────────────────────┐  ┌────────────────────────┐
                          │ fireGiftRecipientEmail │  │ fireGiftClaimEmail     │
                          │ — "you got a gift,     │  │ — "you got a gift,     │
                          │ tap to open"           │  │ tap to claim"          │
                          │ (magic-link login)     │  │ (claim flow)           │
                          └────────────────────────┘  └────────────────────────┘
                                      │                            │
                                      └────────┬───────────────────┘
                                               ▼
                              ┌──────────────────────────────┐
                              │ fireGiftBuyerEmail            │
                              │ — "thanks for your gift to X" │
                              │ (receipt, no magic link)      │
                              └──────────────────────────────┘
```

The claim flow (Model B branch only):

```
recipient taps claim link
        │
        ▼
GET /c/gift/:claimToken  (new claim landing in customer app)
        │
        ▼
recipient enters their phone → OTP sent (existing customer-OTP flow)
        │
        ▼
OTP verified → POST /auth/customer/gift/claim
        │
        ▼ inside tx
1. mark gift_pending_claims.claimed_at = now
2. resolveOrCreateCustomerFromWc (recipient phone)
3. createPunchCard with is_gift=true, gift_* fields
4. mint handoff token, redirect into customer area
```

## Schema changes

### New table — `gift_pending_claims`

```ts
// packages/db/src/schema/gift-pending-claims.ts
export const giftPendingClaims = pgTable(
  'gift_pending_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // WC order this gift belongs to. NOT a FK because WC orders are external,
    // but indexed for the reconciliation path + admin lookup.
    wcOrderId: varchar('wc_order_id', { length: 64 }).notNull(),
    // The matched product SKU — needed at claim time to know what kind of
    // card to mint (entries + validity days).
    wcSku: varchar('wc_sku', { length: 64 }).notNull(),

    // Buyer details (denormalized — buyer may never become a customer).
    buyerFirstName: text('buyer_first_name').notNull(),
    buyerLastName: text('buyer_last_name').notNull(),
    buyerEmail: text('buyer_email').notNull(),
    buyerPhone: varchar('buyer_phone', { length: 20 }).notNull(),

    // Recipient details as entered by buyer at checkout. Source of truth
    // for the gift identity until they claim.
    recipientFirstName: text('recipient_first_name').notNull(),
    recipientLastName: text('recipient_last_name').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    recipientPhone: varchar('recipient_phone', { length: 20 }).notNull(),

    // Claim token (raw lives only in the email; we store its sha256 hash).
    // Same model as handoff_tokens — single-use, time-limited.
    claimTokenHash: varchar('claim_token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    // Set when claim succeeds. Until then the gift can be re-emailed by admin.
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    // FK to the punch card minted on claim. Null until claimed.
    mintedCardId: uuid('minted_card_id').references(() => punchCards.id),
    // Set by the daily expiry-sweep cron when expires_at < now and
    // claimed_at is null. Kept separate from expires_at so the original
    // deadline stays visible in audits.
    expiredAt: timestamp('expired_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('gift_pending_claims_wc_order_id_idx').on(table.wcOrderId),
    index('gift_pending_claims_recipient_phone_idx').on(table.recipientPhone),
    index('gift_pending_claims_expires_at_idx').on(table.expiresAt),
  ],
);
```

### Extend `punch_cards`

Four new columns. All nullable so existing rows stay valid; populated only
when `is_gift=true`.

```ts
// addition to packages/db/src/schema/punch-cards.ts
isGift: boolean('is_gift').notNull().default(false),
giftBuyerFirstName: text('gift_buyer_first_name'),
giftBuyerLastName: text('gift_buyer_last_name'),
giftBuyerPhone: varchar('gift_buyer_phone', { length: 20 }),
giftClaimedAt: timestamp('gift_claimed_at', { withTimezone: true }),
```

Buyer email is intentionally not denormalized onto `punch_cards`; the
relationship is one-way and the buyer's email is only needed at order time
(for the buyer-confirmation email). Keeping the card row leaner.

### Extend `card_settings` (admin-editable per rule 15)

```ts
giftCardsEnabled: boolean('gift_cards_enabled').notNull().default(true),
giftClaimTtlDays: integer('gift_claim_ttl_days').notNull().default(365),
// Recipient-side email copy
giftRecipientEmailSubject: text(...).default('{{buyerFirstName}} שלח/ה לך כרטיסיית מתנה!'),
giftRecipientEmailHeadline: text(...).default('קיבלת מתנה!'),
giftRecipientEmailIntro: text(...).default('{{buyerFirstName}} בחר/ה להעניק לך כרטיסיית מתנה במזה.'),
giftRecipientEmailCtaText: text(...).default('פתחו את הכרטיסייה'),
giftRecipientEmailClaimCtaText: text(...).default('קבלו את המתנה'),
giftRecipientEmailFooterNote: text(...).default('יש לכם שאלות? נשמח לעזור.'),
// Buyer-side confirmation copy
giftBuyerEmailSubject: text(...).default('הזמנת כרטיסיית מתנה ל-{{recipientFirstName}}'),
giftBuyerEmailHeadline: text(...).default('תודה על המתנה!'),
giftBuyerEmailIntro: text(...).default('שלחנו ל-{{recipientFirstName}} מייל עם הכרטיסייה.'),
giftBuyerEmailFooterNote: text(...).default('תקבלו מאיתנו עדכון כשהכרטיסייה תפעל.'),
```

## API surface

### WC-side contract — meta keys we expect

The WC plugin (Yanay's side) must write these to `meta_data` on the order:

| Key | Value |
|---|---|
| `_memesh_gift` | `"yes"` (presence triggers the gift branch) |
| `_memesh_gift_recipient_first_name` | text |
| `_memesh_gift_recipient_last_name` | text |
| `_memesh_gift_recipient_phone` | text — Israeli phone, processor normalizes |
| `_memesh_gift_recipient_email` | text |

Underscore prefix per WC convention (private/internal meta — does not show
on customer-facing receipts unless the theme explicitly displays it).

**One gift per order** (Yoav 2026-06-24): the WC plugin enforces that if
`_memesh_gift=yes` is set, the entire order is a gift. Mixed carts (a
self-purchase line + a gift line in one order) are blocked at WC. Our
processor treats `_memesh_gift` as order-level — every matched line item
in a gift order goes to the recipient.

### New routes

- `GET /auth/customer/gift/preview/:claimToken` — recipient lands here from the
  email; returns gift summary (buyer first name + card teaser) for the claim
  page to render. Does not consume the token.
- `POST /auth/customer/gift/claim` — body: `{ claimToken, phone, otp }`.
  Validates token + OTP match the recipient phone, mints the card, returns a
  handoff token redirecting into the customer area. The claim token + OTP
  pairing is what blocks email-forwarding attacks.

### Modified routes

- [webhooks-wc.ts](apps/api/src/routes/webhooks-wc.ts): no signature change;
  the gift branch lives in the processor.
- [wc-order-processor.ts](apps/api/src/lib/wc-order-processor.ts): gift-meta
  parser, the "is recipient already a customer?" lookup, and the branch into
  direct-mint vs. pending-claim. The existing non-gift path is untouched.

## Tiebreaker rules for the existing-customer check

When a gift order arrives, we look up the recipient in two stages:

1. Match by `recipient_phone` against `customers.phone`. If found → direct-mint.
2. Else match by `recipient_email` against `customers.email`. If found → direct-mint.
3. Else → pending-claim.

**Conflict case** (phone matches customer A, email matches customer B): phone
wins (it is the primary identity in Memesh today). We log
`[wc gift] match_conflict` with both customer IDs so an admin can investigate.

## Email templates

Both gift emails reuse the existing `buildPostPurchaseEmailBody` structure
(table-based layout, inline CSS, dual `dir="rtl"` + `text-align:right`
defenses verified working in Gmail as of 2026-06-24). New builders:

- `buildGiftRecipientEmailBody({ buyerFirstName, recipientFirstName, link, isClaim, logoUrl, copy })`
- `buildGiftBuyerEmailBody({ buyerFirstName, recipientFirstName, recipientEmail, logoUrl, copy })`

### Logo

The official logo (`memeshnoback.png`, 1201×421 PNG, ~35KB) is already
deployed: Yoav swapped its bytes into [apps/customer/public/og-image.png](apps/customer/public/og-image.png)
in a prior session (commit `dd80d36`). The existing post-purchase email
already serves it via `${CUSTOMER_BASE_URL}/og-image.png` ([apps/api/src/lib/post-purchase-email.ts:103](apps/api/src/lib/post-purchase-email.ts#L103)).

Gift emails reuse the same URL convention — no new asset work, no
filename divergence between the two email channels.

### RTL — concrete requirements (per existing pattern in post-purchase-email.ts:241)

Every text-bearing element must carry both:
- HTML attribute `dir="rtl"`
- Inline style `text-align:right;direction:rtl;`

This belt-and-suspenders approach is necessary because Gmail strips the
outer `<html dir="rtl">` in some clients. The pattern is already validated
working in production; the gift templates copy it verbatim. Centered logo
and CTA button cells stay `align="center"`.

## Customer-area UI

### Claim landing — `/c/gift/:claimToken` (new route in apps/customer)

A single-screen flow:

1. Hit `GET /auth/customer/gift/preview/:claimToken` on mount → render gift
   summary: "{buyerFirstName} שלח/ה לך כרטיסיית {N} כניסות במזה"
2. Phone input (RTL, Israeli format) + "שלחו לי קוד אימות" button
3. OTP arrives via SMS → enter 6-digit code
4. On success → handoff token redirect into the customer area, card visible
   with gift badge "מתנה מ-{buyerFirstName}"

Error states:
- **Token unknown/expired:** "הקישור פג תוקף או נוהל. דברו עם השולח/ת."
- **OTP wrong:** "הקוד שגוי, נסו שוב."
- **Phone doesn't match recipient:** "המספר לא תואם. ודאו שאתם הנמען/ת
  המקורי/ת או דברו עם השולח/ת." (Stops email-forwarding attacks at the
  cost of friction for the legitimate-but-wrong-phone case — acceptable.)

### Existing customer area — gift badge

Cards minted from a gift (`is_gift=true`) display a small badge near the
serial: "🎁 מתנה מ-{giftBuyerFirstName}". No deeper UI surface for v1.

## Buyer confirmation email

Sent in both the direct-mint and pending-claim branches. Plain receipt:
"You bought a gift card for {recipientFirstName}, we sent them an email."
No magic link (the buyer is not the recipient). Includes order id for
reference + a footer hint that they will get a notification when the
recipient claims.

## Buyer claim-notification email (NEW per Yoav 2026-06-24)

When a pending-claim row transitions to `claimed_at IS NOT NULL`, fire a
second email to the buyer: "{recipientFirstName} פתח/ה את המתנה שלך!"
Plain confirmation, no magic link. Settings-toggleable via
`giftBuyerNotifyOnClaim` (default ON). The direct-mint branch does NOT
fire this email separately — the buyer's order-confirmation email already
implicitly says "the gift went straight into their account."

Add `giftBuyerNotifyOnClaim: boolean('gift_buyer_notify_on_claim').notNull().default(true)`
to the `card_settings` extension list above, plus
`giftBuyerClaimEmailSubject`, `giftBuyerClaimEmailHeadline`,
`giftBuyerClaimEmailBody`, `giftBuyerClaimEmailFooterNote` copy fields.

## Security (rule 13)

| Threat | Mitigation |
|---|---|
| Email forwarding — attacker forwards the gift email to claim | Phone OTP at claim must match `recipient_phone` from the order |
| Replay of webhook (gift duplicated) | Existing `wc_processed_webhooks` idempotency + advisory lock per order |
| Claim token brute force | sha256 hash stored, raw is 32-byte random base64url, TTL 365 days, single-use, rate limit per IP on `/gift/preview/*` |
| PII exposure — recipient details in DB before consent | Pending-claim row is the minimum needed; deleted on claim (transferred to `customers`) or on expiry sweep |
| Buyer details leaked to recipient | Recipient sees only `buyerFirstName`. No phone, no email, no last name. |
| WC plugin compromised — fake gift meta | Webhook HMAC is the trust boundary; gift meta only acts when HMAC verifies (existing) |
| Compliance — unsolicited recipient email | Email (not SMS) materially lowers Israeli תקשורת law exposure. Yoav decided 2026-06-24 not to add a "I have recipient's consent" checkbox at WC; the email-channel choice is the primary mitigation. Revisit if a complaint lands. |
| Customer phone match conflict | Logged as `[wc gift] match_conflict` for admin review; phone-wins rule is deterministic |

What we deliberately do NOT log: claim token raw value (only `tokenHashPrefix`
first 8 chars of sha256), recipient OTP, buyer email body contents.

## Observability (rule 14)

Every step gets a namespaced log. Same `[wc post-sale]` pattern, new
namespace `[wc gift]`:

| Step | Log |
|---|---|
| Gift meta detected on order | `[wc gift] meta_detected { orderId, recipientPhonePrefix, recipientEmailDomain }` |
| Existing-customer match found | `[wc gift] recipient_matched { matchedBy, customerId }` |
| Phone-vs-email conflict | `[wc gift] match_conflict { phoneCustomerId, emailCustomerId }` |
| Direct-mint branch | `[wc gift] mint_immediate { customerId, cardId }` |
| Pending-claim branch | `[wc gift] pending_created { pendingId, expiresAt, tokenHashPrefix }` |
| Recipient email sent | `[wc gift] recipient_email_sent { providerId, channel: 'magic'\|'claim' }` |
| Buyer email sent | `[wc gift] buyer_email_sent { providerId }` |
| Claim attempt | `[wc gift] claim_attempt { pendingId, tokenHashPrefix }` |
| OTP sent at claim | `[wc gift] claim_otp_sent { phonePrefix }` |
| OTP verified, card minted | `[wc gift] claim_completed { pendingId, customerId, cardId }` |
| Claim rejected (phone mismatch) | `[wc gift] claim_rejected { pendingId, reason: 'phone_mismatch' }` |
| Cron expired an unclaimed gift | `[wc gift] expired_swept { pendingId, ageDays }` |

All logs include `orderId` so a single grep traces the gift end-to-end.

## Settings (rule 15)

Surfaced in admin → Settings → "כרטיסיות מתנה":
- `giftCardsEnabled` master toggle (kill-switch without redeploy)
- `giftClaimTtlDays` (default 90)
- Editable email copy for both recipient and buyer emails (subject, headline,
  intro, CTA, footer) with `{{firstName}}` style placeholders matching the
  existing post-purchase email settings UX shipped in commit `dd80d36`

Defaults pre-populated so the feature works out of the box.

## Cron — expiry sweep

`POST /cron/gift-claims-expire` runs daily. With the 365-day default TTL,
expirations will be rare — but the sweep is cheap and audit-clean. For each
`gift_pending_claims` row where `expires_at < now` AND `claimed_at IS NULL`:
- Add an `expired_at` column populated at sweep time (preferred over
  mutating `expires_at` — keeps the original deadline visible for audits)
- Send the buyer a "your gift was not claimed within {ttlDays} days" notice
- Do NOT auto-refund — refund decisions are manual via admin in v1

Registered in [vercel.json](vercel.json) crons block or wherever the existing
WC reconciliation cron is wired.

## Testing (rule 18)

### Unit tests

- `wc-order-processor.test.ts` — new gift-flow cases:
  - Gift meta present, recipient phone matches existing customer → direct-mint
  - Gift meta present, recipient phone+email both unknown → pending-claim row
  - Gift meta present, phone matches A, email matches B → phone wins, conflict logged
  - Gift meta present but malformed (missing recipient phone) → failure row
  - Reconciliation idempotency: webhook replayed, no duplicate pending or card
  - Non-gift order still works exactly as before (regression guard)
- `gift-email-builder.test.ts` (new) — verify RTL attributes, logo URL, Hebrew
  copy renders, `{{buyerFirstName}}` substitution
- `gift-claim.test.ts` (new) — token validation, OTP verification, phone
  mismatch rejection, expired token rejection

### Integration tests

- End-to-end webhook → pending → claim flow with PGlite
- End-to-end webhook → direct-mint flow (existing recipient)
- Cron expiry sweep marks rows + sends notice without minting

### Manual QA before shipping

- Send a real gift email to a Gmail address and verify:
  - Logo renders (no broken image)
  - All Hebrew lines are right-aligned (Gmail web + Gmail iOS + Outlook web)
  - CTA button is centered, link works
- Run the full claim flow with a phone you control. Confirm OTP arrives,
  claim succeeds, card appears with gift badge.

## Decisions locked 2026-06-24 (no remaining open questions for v1)

| Question | Resolution |
|---|---|
| Buyer consent checkbox at WC | **Skip** — email's lower legal exposure is the primary mitigation |
| Buyer notification on claim | **Yes, default ON**, admin-toggleable via `giftBuyerNotifyOnClaim` |
| Refund/cancel UX | **Defer to v2** — admin handles refunds manually via WC during v1 |
| Mixed carts | **Block in v1** — WC plugin enforces "whole order is gift OR nothing is" |

## Out of scope for v1 (documented for future)

- Personalized message field
- Scheduled delivery (deliver on a chosen date)
- SMS notification (email-only per Yanay's call)
- Buyer-visible "gifts I've sent" history
- Refund/cancel UX
- Multi-gift carts (one gift per order in v1)

## Rollout

1. Schema migrations (`gift_pending_claims` table + `punch_cards` + `card_settings` columns)
2. Backend (parser, branch, builders, claim routes, cron)
3. Customer-area claim UI + gift badge
4. Settings UI extension for gift email copy
5. Tests green → manual QA in preview deployment → ship with
   `giftCardsEnabled` toggle defaulting **ON** in prod. The gift branch only
   triggers when WC sends gift meta_data, so leaving it on before Yanay's
   plugin ships is a no-op for existing orders. The toggle exists as a
   kill-switch for incidents, not as a launch gate.
