---
title: POS sell — SMS with magic link into the customer area
date: 2026-06-22
status: shipped (incl. transactional flip)
owner: Yoav
decider: brother (product owner)
depends_on:
  - apps/api WC checkout-handoff (shipped 2026-06-21) — reuses its token + verify endpoint
  - apps/customer /checkout-complete route (shipped 2026-06-21)
  - apps/api post-sale SMS wrapper sendMarketingSms (shipped earlier)
---

# POS sell — SMS with magic link into the customer area

## Goal in one sentence

When a cashier creates a punch card at the POS, the SMS the customer receives
includes a one-tap link that drops them straight into their personal area
showing the new card — same psychological beat as the WooCommerce
checkout-handoff, no OTP required.

## Why this is worth doing

Today the POS success screen tells the cashier `"שליחת ה-SMS עם ה-QR תיכנס
בעדכון הבא"`. That text was written before the post-sale SMS wrapper was
wired. The truth now:

- Post-sale SMS is already sent from [cards.ts:172-192](../apps/api/src/routes/cards.ts) via `sendMarketingSms({ kind: 'purchase' })`.
- But the SMS body is plain text (`"הכרטיסייה שלך ב-Memesh נוצרה! N כניסות,
  תוקף עד YYYY-MM-DD. מספר סידורי: M-…"`) — no link, no QR.
- The customer has to go to `my.memesh.co.il`, type their phone, wait for OTP,
  enter the code, then see the card. Same friction the WC handoff already
  fixed for online purchases.

This work closes the gap for in-store purchases: an SMS lands with a tap-to-
open link, the customer taps, lands signed in, sees the card. Zero typing.

## Constraints

- Reuse the existing handoff-token + `/checkout-complete` infrastructure. No
  new tables, no new customer-facing routes.
- Keep the SMS path strictly fire-and-log — a failure must not fail the sale.
- The link must work even if the customer doesn't tap it for a while. SMS
  delivery + customer attention is not 5 minutes.
- The text on the staff success screen must stop lying. Fix it the same day
  the link ships.

## Requirements

- **POS cashier sells a card** → API mints a `pos_sell` handoff token, builds
  `https://my.memesh.co.il/checkout-complete?token=<raw>`, includes it in the
  SMS body.
- **Customer taps the link within 24h** → existing `/checkout-complete` page
  exchanges the token, sets the cookie, lands them on `/` signed in with the
  new card visible. No code change on the customer frontend.
- **Customer taps after 24h** → existing FailedCard renders ("הקישור פג /
  נוצל; היכנסו דרך SMS OTP"). No new UX needed.
- **Customer never tapped consent (`marketingConsentAt = null`)** → no SMS at
  all (same as today). The staff screen text qualifies this honestly.
- **Same card gets a second SMS attempt (cashier retries)** → idempotent at
  the application level. Today the SMS is fired-and-forgot off the create
  path; a manual retry would mint a second token. That is fine — both tokens
  are valid until consumed once, the second supersedes the first in practice.

## Out of scope (deliberately)

- Treating purchase SMS as transactional and bypassing `marketingConsentAt`.
  That is a meaningful policy change (Israeli SPAM law has a transactional
  exception for receipts of a thing you just bought) and is a separate
  decision brother needs to take. Flagged in the Open Questions section.
- Apple Wallet / Google Wallet pass attached to the card. Future.
- Per-source rate limiting on the mint endpoint. Not exposed via mint route —
  the cards `/cards` POST is the only minter for `pos_sell`, already auth'd.
- Shortening the URL. The customer area URL + 43-char token = ~83 chars; with
  the existing Hebrew body it costs an extra SMS segment via Pulseem. Cheap
  enough that a URL shortener is overkill.

---

## Chosen approach

**Reuse the WC handoff pipeline with a new `source` value (`pos_sell`).**
The cards POST `/cards` route mints the token inline with the existing
post-sale SMS block; the customer-facing flow is exactly the
`/checkout-complete?token=…` page that already exists.

### End-to-end flow

```
   1. Cashier completes POS sell flow → POST /cards (existing)
        │
        ▼
   2. apps/api/src/routes/cards.ts creates the card, then fires the existing
      fire-and-log post-sale SMS block (existing).
        │
        ▼
   3. NEW: inside that block, before building the SMS body, mint a handoff
      token:
        mintHandoffToken(db, {
          customerId,
          source: 'pos_sell',
          orderRef: card.id,
          ttlMs: 24 * 60 * 60 * 1000,   // 24h
        })
        │
        ▼
   4. NEW: SMS body becomes:
        "הכרטיסייה שלך ב-Memesh נוצרה! N כניסות, <expiry>. צפייה: <url>"
      where <url> = `${CUSTOMER_BASE_URL}/checkout-complete?token=<raw>`.
        │
        ▼
   5. sendMarketingSms({ kind: 'purchase', ... }) (existing). Gated by:
        - smsOnPurchase setting
        - marketingConsentAt (privacy)
        - quiet hours
        │
        ▼
   6. Customer receives SMS → taps the link.
        │
        ▼
   7. my.memesh.co.il/checkout-complete?token=<raw> → existing
      CheckoutComplete.tsx exchanges token via /auth/customer/wc-handoff/verify
      → cookie set → ReadyCard rendered → user clicks CTA → /, signed in, card
      visible.
```

### Key design choices

- **Token TTL: 24 hours** for `pos_sell`. The customer is at the desk now but
  may not look at the SMS for hours. Single-use is still enforced — after
  24h, FailedCard nudges them to OTP. The WC source keeps its 5-minute
  default; only `pos_sell` overrides via `ttlMs`.
- **Source enum: `'pos_sell'`** added to `HandoffTokenSource`. Distinct from
  `wc_checkout` so future audits / per-source rate limiting can diverge.
- **`orderRef: card.id`** so a handoff row can be correlated to a card without
  exposing the qr_token.
- **`CUSTOMER_BASE_URL` env var** on apps/api. Default
  `http://localhost:3030` (matches apps/customer Vite dev). Set to
  `https://my.memesh.co.il` on the Production memesh-api Vercel project.
- **No change to the verify endpoint.** It already returns
  `{ ok: true, profile, thankyou }` for any valid source — the source value
  passes straight through. The existing thankyou copy comes from card_settings
  and reads as "תודה על הרכישה!" which fits POS sell just as well as WC
  checkout.
- **No change to CheckoutComplete.tsx.** The page is source-agnostic by
  design (it never reads `source`). It already strips the token from the URL
  via `history.replaceState`.

### File layout

```
apps/api/src/config.ts                  CHANGED — add CUSTOMER_BASE_URL
apps/api/src/routes/cards.ts            CHANGED — mint token, include in SMS body
apps/staff/src/pos/PosApp.tsx           CHANGED — fix the stale screen text
packages/db/src/handoff-tokens.ts       CHANGED — widen HandoffTokenSource
packages/db/src/handoff-tokens.test.ts  CHANGED — cover pos_sell + custom TTL
apps/api/src/routes/cards.test.ts       NEW — integration test for the SMS body shape
.env.example                            CHANGED — document CUSTOMER_BASE_URL
apps/api/.env.example                   CHANGED — document CUSTOMER_BASE_URL
apps/api-deploy/.env.example            CHANGED — document CUSTOMER_BASE_URL
```

### Staff screen text fix

The string at [PosApp.tsx:1852](../apps/staff/src/pos/PosApp.tsx) becomes:

> `"הכרטיסייה זמינה בכרטיס הלקוח. ללקוחות שאישרו קבלת SMS – נשלח קישור אישי לצפייה."`

Honest about both branches: consent → SMS with link; no consent → nothing sent
(matches today's behavior). Cashier doesn't need to know which branch fired.

## Security (rule 13)

- **Token in SMS body is the attack surface.** SMS is plaintext and may sit
  on a device for a long time. Mitigations:
  - 256-bit entropy (existing).
  - Single-use atomic consume (existing).
  - 24-hour expiry — longer than WC handoff (5min) but still bounded.
  - Customer area cookie is `HttpOnly`, `Secure`, `Domain=.memesh.co.il`,
    `SameSite=lax` (existing).
- **Replay window.** Same as WC handoff: a leaked token can sign in once and
  the cookie is the customer's normal 7-day session. Same as if they'd done
  OTP themselves. No expansion of risk profile.
- **Family-share risk.** Multiple family members on the same SIM could tap
  the link and the first one wins. This is identical to WC handoff and is
  an accepted property of the OTP-by-phone model.
- **Logging.** Same hygiene as `wc_checkout` — only `token_hash_prefix` ever
  appears in logs, raw token never. The new minter logs
  `[cards post-sale] minted handoff token { customerId, cardId, tokenHashPrefix }`.

## Observability (rule 14)

Per the namespaced-log convention:

- `[cards post-sale]` namespace (extends the existing `[cards] post-sale SMS
  failed silently` warning):
  - `[cards post-sale] minted handoff token` on successful mint.
  - `[cards post-sale] skipped link no consent` if SMS gate refused — the
    underlying wrapper already logs this; we annotate here for parity.
  - `[cards post-sale] sms sent { sent: true }` on success.
- The SMS provider logs (`[sms marketing]`) already cover the
  per-recipient outcome.

## Settings (rule 15)

Two existing knobs already control this feature:

1. `smsOnPurchase` (admin → settings) — on/off for the whole post-sale SMS.
2. `marketingConsentAt` per customer — privacy gate.

No new admin-visible settings introduced. The 24-hour TTL is a server-side
constant (not exposed) because:

- It is a security/UX tradeoff, not an operator preference.
- The same tradeoff applies to every customer — no segmentation reason.

If brother later wants to make this configurable (e.g., 7 days for VIP
customers), we add a `posSellLinkTtlHours` setting then. Documented here so
the decision is visible.

## Testing (rule 18)

### Unit tests

- `packages/db/src/handoff-tokens.test.ts` — extend with:
  - `mintHandoffToken accepts source: 'pos_sell' and respects ttlMs override`
  - `consumeHandoffToken returns source: 'pos_sell' on success`

### Integration tests

- `apps/api/src/routes/cards.test.ts` — NEW file using PGlite + an injected
  ConsoleSmsProvider sink:
  - `POST /cards by manager → 201 + card created + SMS body includes
    /checkout-complete?token=… link with the customer's mint token`
  - `POST /cards for customer with no marketingConsentAt → 201 + card
    created + NO SMS sent`
  - `POST /cards for customer with smsOnPurchase=false → 201 + card created
    + NO SMS sent`

### Manual QA

- Local: `pnpm dev` apps/api + apps/staff + apps/customer.
- Set `SMS_PROVIDER=console`, give the test customer `marketingConsentAt`.
- Sell a card via staff POS, copy the console-logged SMS body, paste the
  link in a new tab → lands on customer area signed in with new card.

## Risks, ranked (rule 12)

1. **The marketingConsentAt gate.** Customers who didn't tick "I agree to
   marketing" get NO SMS today — and that remains true after this work. The
   right fix is probably to send the purchase-confirmation SMS as
   transactional (no consent gate, no quiet hours), since they just bought
   the thing. That's a brother decision, scoped to a separate plan.
2. **24h leaked SMS.** Mitigated by single-use, but worth saying out loud.
3. **CUSTOMER_BASE_URL drift in prod.** If the env var is unset, the SMS
   body would contain an `undefined` URL (or worse, a localhost URL leaked
   to prod). Guard: required-in-production validation at config load.

## Open questions

- **Q1. RESOLVED 2026-06-22 — purchase-confirmation SMS is now transactional.**
  See "Decision record: transactional flip" below.
- **Q2.** Should there be an admin setting for "include link in SMS"
  (on/off)? Default on. Flagged for the rule-15 audit pass — current call
  is no, because the link is the whole point of the work.

## Decision record: transactional flip (2026-06-22)

**Decision.** The post-sale SMS is now classified as transactional, not
marketing. Implementation calls `smsProvider.send()` directly (same pattern
as customer OTP), bypassing both the `marketingConsentAt` gate and the
quiet-hours window. The `smsOnPurchase` setting is the only remaining gate.

**Why.**
1. **Empirical.** Verification against the prod DB on 2026-06-22 (see
   `apps/api/scripts/verify-post-sale-sms-state.ts`) returned `0 / 5`
   customers with `marketingConsentAt` set and a quiet-hours window of
   21:00–09:00. Under the original marketing-gate design, the link
   would have reached **zero** of the existing customer base — the
   feature would have been dead on arrival.
2. **Legal.** Israeli Communications Act amendment 40 (חוק התקשורת תיקון 40)
   carves out *transactional* messages from the consent requirement. A
   message confirming "the card you just bought is ready, here is the
   link" is paradigmatically transactional, not marketing.
3. **UX.** A customer who just paid at the counter expects immediate
   confirmation. Holding the SMS until 09:00 the next morning is the
   wrong behavior.

**What is still gated.**
- `smsOnPurchase` (admin → settings) — operator master switch for "send
  any post-sale SMS at all." Kept for cost control + dev environments.

**What changed in code.**
- [apps/api/src/routes/cards.ts](../apps/api/src/routes/cards.ts) — drops
  `sendMarketingSms` from the post-sale block in favor of a direct
  `smsProvider.send()` call. Comment block in-place explains the
  classification and cites the law.
- [apps/staff/src/pos/PosApp.tsx](../apps/staff/src/pos/PosApp.tsx) — the
  success-screen Hebrew copy drops the "ללקוחות שאישרו" qualifier; it
  now reads `"נשלח ללקוח/ה SMS עם קישור אישי לצפייה בכרטיסייה."`

**What we deliberately did NOT do.**
- Did not add a per-customer "I want transactional SMS" toggle. The
  legal regime treats receipts as exempt from consent.
- Did not touch the *marketing* low-entries SMS (`punch.ts`), which
  continues to gate on consent + quiet hours via `sendMarketingSms`.

## Acceptance criteria

- Selling a card via POS to *any* customer (with or without
  `marketingConsentAt`, inside or outside quiet hours) produces an SMS
  whose body contains `${CUSTOMER_BASE_URL}/checkout-complete?token=…`.
- Tapping the link signs the customer in and they see the new card.
- The staff success screen no longer says `"תיכנס בעדכון הבא"`.
- All existing tests pass; new tests pass.
