# WC post-purchase SMS magic link

**Date:** 2026-06-22
**Author:** Claude (Opus 4.7) for Yoav (Flexelent), forwarded request from Yanay
**Status:** Draft — awaiting Yoav green-light

## Goal

When a customer buys a כרטיסיה via memesh.co.il (WooCommerce), the customer
should receive an SMS with a magic link into `my.memesh.co.il/checkout-complete`
in addition to the browser redirect that already happens at the WP thank-you
page. The SMS link MUST be HTTPS.

This is the WC mirror of the POS post-sale SMS shipped in commit `70e0dd2`
(see `_plans/2026-06-22-pos-sell-sms-magic-link.md`).

## Why this matters

The current WC flow only delivers the personal-area link via a server-side
browser redirect on the WP thank-you page. That redirect is lost the moment
the customer:

- closes the tab during the gateway round-trip,
- experiences a mobile browser crash or memory eviction mid-redirect,
- pays from a context where they can't immediately follow the link (in transit,
  at work, etc.) and want a durable handle.

SMS solves the persistence gap — the link sits in the customer's inbox until
they choose to tap it. Yanay specifically asked for it after watching real
customers fail to find their card post-purchase.

The "crucial HTTPS" point in Yanay's note isn't a fear of us emitting plain
HTTP in the SMS body today (the env in prod points at `https://my.memesh.co.il`).
It's the correctly-paranoid observation that the guarantee currently lives in
operational convention, not in the schema — a misconfigured env var would
silently ship `http://` links. We close that gap as part of this work.

## Decision: where to send the SMS

**Send from any code path that creates cards** — concretely, both
`/webhooks/woocommerce/order` (the async webhook) and
`/auth/customer/wc-handoff/mint` (the inline call WP makes on the
thank-you page). Both routes already invoke `processWcOrderWebhook`;
both check `result.cardsCreated.length > 0` and fire a shared
`fireWcPostPurchaseSms` helper.

**Why both routes** — these are not redundant. The mint endpoint frequently
runs FIRST (the WP thank-you page hook fires inline; the webhook is
delivered asynchronously, sometimes minutes later). If only the webhook
fires SMS, then in the common case the mint call creates the cards →
later the webhook arrives → sees cards already exist → cardsCreated is
empty → no SMS. Customer gets nothing. The fix is to fire SMS from
whichever path actually created the cards.

**Single-SMS guarantee** — `cardsCreated.length > 0` is the dedup key.
Whichever path creates the cards has a non-empty `cardsCreated`; the
second path arrives, sees cards already exist (advisory lock +
`countCardsForWcOrder`), returns processed with empty `cardsCreated`,
skips SMS. No race because the advisory lock serializes the two paths
per WC order.

Considered and rejected:

- **Webhook only** — bug described above; the inline mint path is the
  common case and would silently produce zero SMS.
- **Move SMS firing INTO `processWcOrderWebhook`** — would require
  injecting smsProvider/env/log into the processor and updating all 21
  existing processor tests. The processor's job is "decide what to
  create"; SMS firing is a route-level concern. Keeping it out keeps the
  processor unit-testable on a tighter contract.
- **New WP-callable endpoint** — adds a second hop with no reliability
  gain. The webhook + mint already cover both delivery channels.

Tradeoff accepted: a single checkout will mint **two** handoff tokens for
the customer (one for the browser redirect via `/wc-handoff/mint`, one for
the SMS via the webhook). They are **independent rows** with different
hashes — each is single-use on its own row, so the customer tapping
both the redirect and the SMS produces two clean sign-ins, not a
"second tap fails" error. The unused token simply sits until the 24h
cleanup cron removes it. Storage cost is negligible.

## HTTPS guarantee — schema-level enforcement

Add a refine in `apps/api/src/config.ts` `superRefine` that rejects any
`CUSTOMER_BASE_URL` whose `protocol !== 'https:'` when `NODE_ENV === 'production'`.

Dev keeps the `http://localhost:3030` default (Vite). Prod refuses to boot
on http://. Result: the SMS link being https is enforced at the schema
boundary, not at the convention.

Status of the existing guard: today the superRefine rejects localhost in
prod but not http://*.example.com. This is a real gap and this PR closes it.

## Implementation steps

### 1. Tighten `config.ts`

Inside the existing `superRefine`, after the localhost check, add:

```ts
if (u.protocol !== 'https:') {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['CUSTOMER_BASE_URL'],
    message: 'CUSTOMER_BASE_URL must use https:// in production (e.g. https://my.memesh.co.il)',
  });
}
```

The block now refuses three classes of misconfiguration in prod:
1. Garbage URL (existing `try { new URL(...) }` catch).
2. localhost / 127.0.0.1 / 0.0.0.0 (existing).
3. http:// (new).

Update `apps/api/src/config.test.ts` with two new cases:
- Prod + `http://my.memesh.co.il` → parse throws on `CUSTOMER_BASE_URL`.
- Prod + `https://my.memesh.co.il` → parse succeeds.

### 2. Rename `buildPosSellSmsBody` → `buildPostSaleSmsBody`

The body builder in `apps/api/src/lib/post-sale-sms.ts` is already generic
(no POS-specific text in it). Now that there are two callers, the name
should reflect that. Mechanical rename across:

- `apps/api/src/lib/post-sale-sms.ts` (function declaration + JSDoc)
- `apps/api/src/lib/post-sale-sms.test.ts` (import + test names)
- `apps/api/src/routes/cards.ts` (single call site)

No behavior change.

### 3. Wire the SMS into the WC webhook processor

In `wc-order-processor.ts`, **after** the `serials: string[]` loop fills
in (cards are minted, customer exists), add a `void (async () => { ... })()`
block that mirrors the POS pattern in `cards.ts:204-257`:

- Read `cardSettings.smsOnPurchase` — bail if off (with an info log).
- Mint a `wc_checkout` token for `customer.id` with `ttlMs = 24h` and
  `orderRef = orderIdStr`. (NOTE: the existing browser-redirect mint at
  `/wc-handoff/mint` keeps the 5-min default — those tokens are short-lived
  by design because the redirect is immediate.)
- Build link as `${env.CUSTOMER_BASE_URL}/checkout-complete?token=${minted.raw}`.
  Link is https because (1) prod env enforces it via step 1 above, (2) dev
  uses http://localhost intentionally.
- For the body: **branch on card count.**
  - 1 card created in this delivery → render the existing POS-style body
    (`"הכרטיסייה שלך ב-Memesh נוצרה! 12 כניסות, תוקף עד 2027-06-22.
    צפייה בכרטיסייה: <link>"`).
  - 2+ cards → render a generic multi-card body
    (`"נוצרו {N} כרטיסיות חדשות ב-Memesh! לצפייה באזור האישי: <link>"`).
  Reason: claiming "12 entries, valid until X" when the customer bought
  two cards is a false at-a-glance claim that would surface as a Yanay
  flag. The multi-card branch keeps the SMS honest and steers the customer
  to the personal area where they see all cards.
- Call `smsProvider.send`, log success/failure (with `tokenHashPrefix` for
  correlation), swallow errors so the webhook still returns 200.
- Wrap the entire SMS attempt in try/catch so any unexpected throw never
  bubbles back into `processWcOrderWebhook`'s return value.

**Critical:** the SMS block must run **outside** the transaction. The
transaction in `processWcOrderWebhook` commits the card creation, then
returns. If the SMS attempt is inside the transaction, a Pulseem timeout
would roll back the card. We move the SMS firing to the route handler in
`webhooks-wc.ts` (post-`processWcOrderWebhook`) so it operates on already-
committed data — same pattern as cards.ts has the SMS outside the create
path.

Alternative: keep the SMS inside `wc-order-processor.ts` but **after** the
`return` from `db.transaction(...)`, scheduled via `void`. Cleaner from
the route's POV (route stays a thin webhook handler). Pick this — it keeps
all "WC processing" concerns in one file.

Refactor: `processWcOrderWebhook` will need to return enough customer +
card info so the SMS block can run. It already returns `customerId`; we
extend the `processed` result with `{ customerPhone, cardsSummary: Array<{
totalEntries, expiresAt }> }`. The route already only reads
`result.cardsCreated.length` for the response, so this is additive.

The SMS fire belongs **in the route**, between processor returning and
the route replying. Reasons:
1. The route has access to `request.log` for the structured logs we want.
2. The processor stays pure / testable.
3. The route already logs processed/duplicate/etc. — the SMS log slots in
   next to `'[webhook wc] done'`.

Pattern: on `'processed'`, fire `void (async () => { ...sms... })()` after
`reply.send(...)` so the 200 response isn't blocked by Pulseem latency.

### 4. Update env examples

- `.env.example`, `apps/api/.env.example`, `apps/api-deploy/.env.example` —
  amend the existing `CUSTOMER_BASE_URL` comment to note: "in production,
  this MUST be https:// — the config rejects http:// at boot."

### 5. Tests

Add to `apps/api/src/routes/webhooks-wc.test.ts` (or create if missing):

- Order webhook → cards created → SMS provider receives ONE call with a
  body that contains `${CUSTOMER_BASE_URL}/checkout-complete?token=`,
  matches the Hebrew copy, and the token hash exists in the
  `customer_login_tokens` table with `source='wc_checkout'`.
- Same path but `smsOnPurchase: false` → cards created, SMS provider NOT
  called.
- Webhook duplicate delivery → cards NOT re-created and SMS NOT re-sent
  (idempotency: the SMS only fires when the processor returns 'processed',
  not 'duplicate').

`apps/api/src/lib/post-sale-sms.test.ts` — rename touches the test names.
Add two new test cases for the multi-card branch:
- `buildPostSaleSmsBody` with `cards.length === 2` → body contains
  `"נוצרו 2 כרטיסיות חדשות"`, does NOT contain `"כניסות"` (no
  per-card count claim), ends with the link.
- `buildPostSaleSmsBody` with `cards.length === 1` → unchanged from
  today's `buildPosSellSmsBody` golden test.

`apps/api/src/config.test.ts` — two new cases for the https guard (above).

### 6. Manual QA pass (Rule 6)

Walk through:

1. **Golden:** WC test order → webhook fires → card row in DB → SMS appears
   in `console` provider stdout in dev / Pulseem logs in prod → tap link →
   `/checkout-complete` consumes token → customer cookie set → personal
   area shows the new card.
2. **smsOnPurchase off:** flip the setting in admin → re-run the webhook →
   card created, SMS skipped, log line `[wc post-sale] skipped: smsOnPurchase disabled`.
3. **Reconciliation re-run:** the reconciliation cron re-fetches the same
   order, processor returns `'duplicate'`, NO SMS goes out (verified by
   test).
4. **Phone normalization:** WC sometimes ships local-format phones
   (`054-...`). The processor already normalizes via `phoneSchema`; SMS
   uses `customer.phone` post-normalization. Confirm in test.
5. **HTTP prod boot:** set `CUSTOMER_BASE_URL=http://my.memesh.co.il`
   with `NODE_ENV=production` → API refuses to boot (z parse throws).
6. **Two-token race:** customer somehow reaches both the WP thank-you page
   AND taps the SMS. First tap consumes its token; second tap shows the
   existing "invalid_or_consumed_token" error which the customer area
   handles gracefully (falls back to OTP login).

## Settings audit (Rule 15)

This work introduces NO new settings — it piggybacks on the existing
`smsOnPurchase` master switch, which already gates the POS post-sale SMS.
That is the correct shape: one operator switch covers all transactional
post-purchase SMS, whether the sale came from POS or WC.

Considered and rejected: a per-channel switch (`smsOnPosPurchase` /
`smsOnWcPurchase`). Adds operational complexity for a benefit Yanay has
not asked for. Can be split later without migration if the need arises.

## Observability (Rule 14)

New log lines, all under the `[wc post-sale]` namespace to match the
existing `[wc handoff mint] / [wc handoff verify] / [webhook wc]` pattern:

- `[wc post-sale] skipped: smsOnPurchase disabled` (info, with orderId, cardsCreated)
- `[wc post-sale] minted handoff token` (info, with orderId, customerId, tokenHashPrefix, expiresAt)
- `[wc post-sale] sms sent` (info, with orderId, tokenHashPrefix, providerId)
- `[wc post-sale] sms provider error` (warn, with orderId, tokenHashPrefix, error)
- `[wc post-sale] sms failed silently` (warn, with orderId, err) — last-resort try/catch

Mirrors the POS path's log shape so a future operator can grep both with the
same patterns.

## Security (Rule 13)

- **Link is server-built.** Token + URL never come from client input — they're
  composed in the API from the validated `env.CUSTOMER_BASE_URL` and a
  freshly-minted `customer_login_tokens` row. The same defense the POS path
  has against a leaked SMS pointing somewhere else.
- **Token has 256 bits of entropy**, hashed at rest (`tokenHashPrefix` only
  in logs), single-use, 24h TTL. No change to the security shape of
  `customer_login_tokens`.
- **HTTPS is enforced at schema boot**, not in code paths that emit the SMS.
  Defense in depth: even if some future caller forgets to use the env var,
  the env var itself cannot be set to http:// in prod.
- **Transactional classification.** Same Israeli Comm. Act amend. 40
  carve-out the POS path relies on: the SMS confirms a paid transaction
  the customer just completed. Bypasses marketingConsentAt and quiet hours
  for that reason. Honors smsOnPurchase as the operator master switch.
- **Webhook signature unchanged** — the HMAC-SHA256 path in webhooks-wc.ts
  stays the same. SMS firing is downstream of the existing trust boundary.

## Cost note (Rule 8)

Pulseem per-SMS pricing — I have not re-checked it for this plan. Yanai's
account is already paying for the POS path; this adds one SMS per online
purchase. Volume is bounded by web sales (low single-digit per day today
based on the brief), so the incremental monthly cost is in the shekels-not-
hundreds range. Worth confirming current per-SMS rate before merging, but
not a blocker.

## Decision: reconciliation cron does NOT fire SMS

`processWcOrderWebhook` has a third caller — the hourly reconciliation cron
in `apps/api/src/lib/wc-reconciliation.ts`. We deliberately do NOT wire
`fireWcPostPurchaseSms` into that path. Reasons:

1. Webhook (durable, WC retries on 5xx) + inline mint (typical case)
   together cover ~100% of real purchases. The cron is a safety net for
   the rare cases where BOTH failed.
2. The cron runs hourly; an SMS saying "your purchase is complete" that
   arrives 6h after the purchase is confusing rather than helpful.
3. The customer isn't locked out — OTP login at my.memesh.co.il works
   independently. The magic-link is a convenience, not the only path.

If observability later shows real customers losing the SMS to webhook+mint
double-failure, we can add SMS to the cron path with a stale-purchase
threshold (e.g. skip SMS for orders >2h old). Out of scope for v1.

## Out of scope

- WhatsApp / email channels for the same post-purchase notification.
- Bundling multi-card orders into a richer SMS body. First-card teaser
  is the v1.
- Per-channel SMS opt-out granularity (the existing `smsOnPurchase` master
  switch is sufficient).
- Changes to the WP-side plugin. The handoff/mint endpoint continues to
  work exactly as before for the browser-redirect path.

## Open questions for Yoav — resolved 2026-06-22

1. ~~Pulseem cost check~~ — **approved, known price, skip.**
2. ~~Two-token semantics~~ — **dropped, phantom concern.** Each token is
   its own row; tapping both the redirect and the SMS produces two clean
   sign-ins, not an error.
3. ~~First-card semantics~~ — **branch on count.** Single-card → POS-style
   body. Multi-card → generic "N כרטיסיות" body. No false at-a-glance claim.
