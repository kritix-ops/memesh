---
title: WooCommerce checkout → my.memesh.co.il auto-login handoff
date: 2026-06-21
status: proposed
owner: Yoav
decider: brother (product owner)
depends_on:
  - apps/api WC webhook processor (already shipped, processWcOrderWebhook)
  - apps/api customer auth + cookies (shipped Phase 6)
  - my.memesh.co.il deployed (shipped Phase 6)
---

# WooCommerce checkout → my.memesh.co.il auto-login handoff

## Goal in one sentence

When a customer completes a WooCommerce checkout on `memesh.co.il`, redirect their browser to `my.memesh.co.il` with them already signed in to their personal area — no OTP, no SMS spend, no second authentication step.

## Why this is worth doing

The current post-purchase flow drops a customer back on the WooCommerce thank-you page, then they have to manually visit `my.memesh.co.il`, type their phone, wait for an SMS, enter the code, and only then see the punch card they just bought. That's five steps and ~30 seconds of friction at the exact moment the customer feels best about the purchase. A direct handoff converts the "purchase complete" moment into the "your card is right here" moment — same psychological beat, no clicks.

It also closes the OTP-spam-folder problem for new customers in one direction: a first-time buyer never has to receive an OTP at all to see their first card. They'll only deal with SMS-OTP later if they sign in from a different browser.

## Constraints

- WordPress at `memesh.co.il` is on a different host stack than our Node/Vercel deploys — communication is HTTP-only, no shared filesystem or process.
- WordPress write access exists (Yoav has it) but **brother decides** what ships on the WP side. This plan is the proposal that goes to him.
- Cookies on `my.memesh.co.il` are `Domain=.memesh.co.il`, `HttpOnly`, `Secure`, `SameSite=lax` (Phase 6 topology).
- No new paid services. All work uses existing Vercel + Neon + WordPress infra.
- The existing `processWcOrderWebhook` in `apps/api/src/lib/wc-order-processor.ts` is idempotent and already handles "create-or-find customer + create-or-find punch cards" from a WC order payload. Reuse this; do not duplicate the logic.

## Requirements (who/what/when)

- **First-time buyer:** completes WC checkout → lands on `my.memesh.co.il/checkout-complete?token=...` → after ~200ms exchange → sees their new card on `my.memesh.co.il/`, signed in. Zero typing, zero OTP.
- **Returning buyer:** identical flow. Their previous customer record is matched by phone; a new card is appended to it.
- **Guest WC checkout (no WP account):** the WC webhook already creates the Memesh customer from the order's billing fields. The handoff matches on phone, same as authenticated checkout.
- **Customer revisits the handoff URL later** (e.g., closed the tab, found the URL in browser history): exchange returns 401 (token consumed), frontend redirects to the OTP login form. No information leakage.
- **A bug or outage between WC and our API** at the moment of redirect: customer lands on `my.memesh.co.il/checkout-complete` with a token that can't be exchanged → fallback to OTP login with a clear "your purchase was successful — please sign in to see your card" message.

## Out of scope (deliberately)

- The Apple Wallet / Google Wallet pass that this handoff page could eventually include in v2. Not now.
- Email-receipt content changes. WC + WordPress own that and it's already a separate workflow.
- Refund / cancellation flows. Existing API + admin surface already handles these.
- Marketing-list opt-in tweaks at the handoff moment. Out of scope.
- A "merge two existing customer records" flow if the WC order's phone matches one customer but email matches another. The processor already prefers phone; documented as known limitation, not addressed here.

---

## Chosen approach

**Pattern A from the design discussion: a one-time DB-stored handoff token, minted by an authenticated WP-to-API call, exchanged by the customer frontend for a normal session cookie.**

### End-to-end flow

```
                                                                                  
   1. Customer completes WC checkout (clicks "place order", PSP returns success)
        │
        ▼
   2. WordPress fires `woocommerce_order_status_processing` hook (server-side PHP)
        │
        ▼
   3. WP plugin POSTs https://api.memesh.co.il/auth/customer/wc-handoff/mint
       Authorization: Bearer <WP_HANDOFF_SHARED_SECRET>
       Body: { orderId, phone, email, firstName, lastName, source: 'wc_checkout' }
        │
        ▼
   4. API runs processWcOrderWebhook (idempotent) → customer + cards exist
       │
       │   then →
       │
       ▼
   5. API mints a fresh customer_login_token row:
       - tokenHash = sha256(rawToken)
       - customerId = the customer just created/matched
       - source = 'wc_checkout'
       - expiresAt = now + 5 minutes
       - consumedAt = null
       - orderRef = orderId  (for audit + idempotency)
       └─ Returns rawToken (43-char base64url) to WP
        │
        ▼
   6. WP plugin replaces WC's default "thank you" redirect with:
       https://my.memesh.co.il/checkout-complete?token=<rawToken>
        │
        ▼
   7. Customer's browser arrives at my.memesh.co.il/checkout-complete?token=...
        │
        ▼
   8. Customer frontend reads token, POSTs to
       https://api.memesh.co.il/auth/customer/wc-handoff/verify
       Body: { token: rawToken }
       credentials: include
        │
        ▼
   9. API atomically: SELECT FOR UPDATE on tokenHash → WHERE consumedAt IS NULL
                                                     AND expiresAt > now
       If found: mark consumedAt = now, sign a customer_token JWT, Set-Cookie,
                 return { ok: true, profile: <customer> }
       If not found: return 401 { error: 'invalid_or_consumed_token' }
        │
        ▼
  10. Customer frontend on success:
       - history.replaceState('/') — strips token from URL + browser history
       - hydrates session state from the just-returned profile
       - shows the customer's punch cards
  
       On failure (401):
       - clears the token from URL
       - shows a brief "your purchase succeeded — please sign in to see your card"
       - falls back to the existing OTP login form
```

### Key design choices, called out

- **Token format**: `crypto.randomBytes(32)` rendered as base64url. ~43 ASCII characters. URL-safe, no padding. 256 bits of entropy — same shape as the customer-token JWT already in use, just opaque.
- **Storage shape**: only the SHA-256 hash of the token is stored. The raw token exists in three places: WP's HTTP response, the redirect URL, the browser's address bar — and is gone from all three within seconds (consumed → URL replaced → never logged).
- **Lifetime**: 5 minutes. The customer is sitting at WP's redirect; they have at most ~30 seconds of attention. 5 minutes is the wide-margin upper bound for a slow checkout PSP latency + slow phone parsing the redirect URL.
- **Single-use**: enforced atomically at the DB layer with `UPDATE ... WHERE consumedAt IS NULL RETURNING ...`. No race window where the same token can be exchanged twice.
- **Phone is the match key** at the customer lookup step. Email is the fallback (matches what the WC webhook processor already does).
- **Inline processing at mint** time: step 4 runs the same `processWcOrderWebhook` code path as the live WC webhook. Whichever fires first — webhook or mint — creates the customer; the other is a no-op. No race condition between them.
- **The WP-to-API auth** is a static shared secret (`WP_HANDOFF_SHARED_SECRET`, 32+ chars), passed in an Authorization header. Not a per-request HMAC — the body isn't sensitive enough to warrant the complexity, and the secret is server-to-server only.

### File layout

```
apps/api/
  src/
    routes/
      wc-handoff.ts                NEW — mint + verify endpoints
    lib/
      handoff-tokens.ts             NEW — repo methods + token helpers

packages/db/
  src/
    schema/
      customer-login-tokens.ts      NEW — new table
    handoff-tokens.ts               NEW — drizzle queries
    handoff-tokens.test.ts          NEW — unit tests against PGlite
  migrations/
    <timestamp>_customer_login_tokens.sql   NEW — auto-generated by drizzle-kit

apps/customer/
  src/
    customer/
      CheckoutComplete.tsx          NEW — single-purpose page that owns the
                                          token exchange + redirect
    App.tsx                         CHANGED — route /checkout-complete

# WordPress side (lives in your WP install, not this repo)
wp-content/
  plugins/
    memesh-checkout-handoff/        NEW (you decide where it lives)
      memesh-checkout-handoff.php
```

### Schema addition

New table `customer_login_tokens`:

```sql
CREATE TABLE customer_login_tokens (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash      varchar(64)   NOT NULL UNIQUE,         -- sha256 hex
  source          varchar(40)   NOT NULL,                -- 'wc_checkout', future others
  order_ref       varchar(64),                            -- WC orderId for audit
  expires_at      timestamptz   NOT NULL,
  consumed_at     timestamptz,                            -- null until exchanged
  created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX customer_login_tokens_customer_id_idx ON customer_login_tokens(customer_id);
CREATE INDEX customer_login_tokens_expires_at_idx ON customer_login_tokens(expires_at) WHERE consumed_at IS NULL;
```

### API endpoints

**`POST /auth/customer/wc-handoff/mint`** — called by WordPress only.

- Authorization: `Bearer ${WP_HANDOFF_SHARED_SECRET}` (static, 32+ chars).
- Rate-limited to a generous 60 req/min per IP (WP's IP), enough to absorb checkout bursts.
- Request body shape:
  ```ts
  {
    orderId: string;        // WC order ID
    phone: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    source: 'wc_checkout';
    // The full WC order payload is also accepted so the webhook processor
    // can run inline — same shape as the webhook receiver expects.
    order?: WcOrderPayload;
  }
  ```
- Behavior:
  1. Verify Authorization header (constant-time compare).
  2. If `order` is present, run `processWcOrderWebhook(order, source: 'mint')`. Idempotent.
  3. Find customer by normalized phone, falling back to email.
  4. If no customer (and no `order` was supplied for inline processing) → 409 `{ error: 'customer_not_ready' }`.
  5. Generate token, hash, store row with 5-min expiry.
  6. Return `{ token: rawToken, expiresAt }`.

**`POST /auth/customer/wc-handoff/verify`** — called by the customer frontend.

- No auth header. Body-bearer-token style.
- Rate-limited to 10 req/min per IP — token verification is the abusable surface.
- Request body:
  ```ts
  { token: string }
  ```
- Behavior:
  1. Hash the token, query the table.
  2. Atomic update: `UPDATE customer_login_tokens SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING customer_id`.
  3. If no row updated → 401 `{ error: 'invalid_or_consumed_token' }`.
  4. Look up customer profile.
  5. Sign a customer_token JWT (same as the OTP verify route does).
  6. `setCustomerCookie` (same helper as the OTP flow uses).
  7. Return `{ ok: true, profile: { ... } }`.

### Frontend route

New `apps/customer/src/customer/CheckoutComplete.tsx`:

- Reads `token` from `window.location.search`.
- On mount, calls `apiRequest('/auth/customer/wc-handoff/verify', { method: 'POST', body: { token }, audience: 'customer' })`.
- On success:
  - `history.replaceState({}, '', '/')` — strips token from URL + history.
  - Calls `useCustomerSession().setProfile(profile)` to hydrate state directly.
  - Renders nothing (immediate render of the parent `CustomerApp` with the new state).
- On failure:
  - `history.replaceState({}, '', '/')` — same URL cleanup.
  - Renders a 5-second "purchase succeeded, please sign in to see your card" toast.
  - Falls through to the OTP login form.

The route is added in `App.tsx` with a thin guard: anything with `?token=...` on path `/checkout-complete` mounts `CheckoutComplete` instead of the default landing.

### WordPress plugin (skeleton for brother to review)

This is the entirety of the WP-side code, kept small on purpose. The file `wp-content/plugins/memesh-checkout-handoff/memesh-checkout-handoff.php`:

```php
<?php
/**
 * Plugin Name: Memesh — Checkout handoff to my.memesh.co.il
 * Description: After a WooCommerce order completes, mint a single-use login
 *              token via the Memesh API and redirect the customer to their
 *              personal area, already signed in.
 * Version: 1.0
 */

if (!defined('ABSPATH')) exit;

const MEMESH_API_BASE = 'https://api.memesh.co.il';
const MEMESH_HANDOFF_TIMEOUT_SEC = 8;

/**
 * Fires after WC has set the order status to 'processing' (paid, before shipping).
 * For digital-only stores this is effectively the "purchase complete" moment.
 */
add_action('woocommerce_thankyou', function ($order_id) {
    $secret = getenv('MEMESH_HANDOFF_SECRET');
    if (!$secret) {
        error_log('[memesh handoff] MEMESH_HANDOFF_SECRET not set, skipping');
        return;
    }
    $order = wc_get_order($order_id);
    if (!$order) return;

    $payload = [
        'orderId'   => (string) $order_id,
        'phone'     => $order->get_billing_phone(),
        'email'     => $order->get_billing_email(),
        'firstName' => $order->get_billing_first_name(),
        'lastName'  => $order->get_billing_last_name(),
        'source'    => 'wc_checkout',
        // The full order JSON so the API can run its webhook processor inline.
        // Match the shape the existing webhook receiver already accepts.
        'order'     => $order->get_data(),
    ];

    $res = wp_remote_post(MEMESH_API_BASE . '/auth/customer/wc-handoff/mint', [
        'headers' => [
            'Authorization' => 'Bearer ' . $secret,
            'Content-Type'  => 'application/json',
        ],
        'body'    => wp_json_encode($payload),
        'timeout' => MEMESH_HANDOFF_TIMEOUT_SEC,
    ]);

    if (is_wp_error($res)) {
        error_log('[memesh handoff] mint request error: ' . $res->get_error_message());
        return;  // fall back to default thank-you page
    }

    $code = wp_remote_retrieve_response_code($res);
    if ($code !== 200) {
        error_log("[memesh handoff] mint non-200: $code body: " . wp_remote_retrieve_body($res));
        return;  // fall back to default thank-you page
    }

    $body = json_decode(wp_remote_retrieve_body($res), true);
    if (empty($body['token'])) {
        error_log('[memesh handoff] mint response missing token');
        return;
    }

    $token = $body['token'];
    $redirect_url = 'https://my.memesh.co.il/checkout-complete?token=' . urlencode($token);

    // Display a tiny "redirecting…" page that JS-navigates to my.memesh.co.il.
    // We don't use wp_safe_redirect because by this point the thank-you page
    // has already started rendering.
    echo '<script>window.location.replace(' . wp_json_encode($redirect_url) . ');</script>';
    echo '<noscript>Redirecting… <a href="' . esc_attr($redirect_url) . '">Continue manually</a></noscript>';
});
```

The shared secret `MEMESH_HANDOFF_SECRET` lives in the WP server's environment (set via the host's control panel, not in `wp-config.php` if avoidable — secrets in PHP code get accidentally committed). The same value is set as `WP_HANDOFF_SHARED_SECRET` on memesh-api in the Vercel dashboard.

**Things brother should review before this ships:**

1. Whether the redirect should happen on `woocommerce_thankyou` (after page render starts), `woocommerce_order_status_processing` (server-side, before any redirect), or `woocommerce_payment_complete` (specifically after the PSP returns success but before status flips). The hook choice changes the customer-visible behavior subtly.
2. Whether to keep WC's own thank-you page as a fallback for failures (recommended — currently the code does this implicitly by returning early on errors).
3. Whether to include the order's line items / pricing in the payload to the mint endpoint, so the API can show "your new card" with the right copy on the landing page. (V2 — start with a simple "your card is ready" overview.)

---

## Security (rule 13)

The handoff token is the new attack surface. Walking it:

- **Token exposure window.** The raw token lives in three places: the JSON body of WP's API call, the URL of the redirect, and the browser's address bar / history. Each window is seconds, and the single-use enforcement means a leaked token can be exchanged at most once. **Mitigation:** 5-minute expiry, single-use atomic consume, immediate `history.replaceState` on the frontend to strip the URL after exchange.
- **Replay.** Single-use enforcement at the DB level (atomic UPDATE WHERE consumed_at IS NULL). Even if the same token is presented twice in a 5-minute window, only the first request wins.
- **Brute force.** 256-bit token, hashed lookup. 5-minute expiry. Even at 10 req/min/IP (the rate limit) and an unrealistic 1000 IPs, brute-forcing one valid token within its lifetime is computationally infeasible.
- **WP-to-API auth.** Static shared secret (`WP_HANDOFF_SHARED_SECRET`). 32+ chars. Stored in WP's host env (not WP database, not committed). Constant-time compared on the API side.
- **Customer impersonation via WP compromise.** If WP is compromised, the attacker has the shared secret and can mint a token for any phone in their target's DB. **Honest take:** this is the same risk profile WP already has — WP can already create customers, write to the DB indirectly via the WC webhook, etc. The handoff doesn't expand the attacker's capabilities meaningfully if they already own WP.
- **Cookie scope.** The session cookie set by the verify endpoint is the same `customer_token` cookie set by the OTP flow. `Domain=.memesh.co.il`, `HttpOnly`, `Secure`, `SameSite=lax`. No new cookie scope.
- **CSRF.** The verify endpoint is POST, body-bearer-token style. SameSite=lax + the requirement to know the token blocks classic CSRF.
- **Logging hygiene.** The raw token MUST NEVER appear in any log. Log only `token_hash_prefix` (first 6 chars of the SHA-256) so a successful + failed exchange can be correlated in logs without exposing the token itself.
- **Token enumeration by customer.** A customer accessing their own profile cannot list their handoff tokens (no endpoint exposes them). Internal-only via admin.

## Observability (rule 14)

Per the project's namespaced-log convention:

- `[wc handoff mint]` — `received`, `customer_resolved`, `token_minted` (with token_hash_prefix only), `failed`.
- `[wc handoff verify]` — `received`, `token_consumed` (success), `rejected` with reason `invalid_or_consumed` | `expired`.
- `[wc handoff inline-processor]` — wraps the inline `processWcOrderWebhook` call so its existing logs are namespaced for this code path.
- WP-side `error_log`'d events use the prefix `[memesh handoff]` for symmetry.

A failed handoff has THREE log lines from a single attempted purchase that should always correlate:
1. `[memesh handoff] mint request error / non-200` on WP
2. (no API log if WP never reached us; otherwise `[wc handoff mint] failed`)
3. (no frontend log; the customer landed at the default WC thank-you page)

A successful handoff has FOUR lines:
1. `[memesh handoff] mint request 200` (WP)
2. `[wc handoff mint] token_minted` (API)
3. `[customer boot]` + `[wc handoff verify] token_consumed` (API)
4. `[web customer me] hydrated signed in` (frontend)

If any one is missing, the failure mode is localized to that boundary.

## Settings (rule 15)

This is infrastructure. No user-visible settings introduced. Server env vars:

- `WP_HANDOFF_SHARED_SECRET` on memesh-api (Vercel dashboard, sensitive, 32+ chars)
- `MEMESH_HANDOFF_SECRET` on the WP server (host env)
- These two are the same value, set on both sides.

No new persistent customer-facing settings. If brother later wants the "your card is ready" landing page to support a customizable copy, that's a separate feature with its own settings work.

## Testing (rule 18)

### Unit tests

- `packages/db/src/handoff-tokens.test.ts` — table CRUD + atomic-consume semantics against PGlite.
  - mint → row exists with correct hash + expiry
  - consume → consumedAt set, second consume returns null (atomicity)
  - expired tokens are not consumed
  - tokens for a deleted customer cascade-delete

### Integration tests (apps/api)

- `apps/api/src/routes/wc-handoff.test.ts`:
  - mint without Authorization → 401
  - mint with wrong secret → 401
  - mint with valid secret + new customer (via inline order) → 200 + token returned + customer row exists
  - mint when customer already exists from prior WC webhook → 200 + token returned + no duplicate customer
  - mint without `order` payload and no matching customer → 409 `customer_not_ready`
  - verify with valid token → 200 + sets cookie + profile returned
  - verify with consumed token → 401 `invalid_or_consumed_token`
  - verify with expired token → 401
  - verify with garbage token → 401
  - rate-limit on verify (10/min/IP) returns 429 on the 11th call

### Manual QA

- Place a real test order on the WP staging (or live) site. Confirm:
  - Browser ends up on `my.memesh.co.il/` (NOT `/checkout-complete?token=...`)
  - Customer is signed in (DevTools → cookies → `customer_token` with `Domain=.memesh.co.il`)
  - The newly bought card is visible in the cards view
  - Reloading the page keeps you signed in
  - Going back to the `/checkout-complete?token=...` URL via browser history → falls back to OTP login cleanly
- Repeat with email-only WC checkout (no phone) — confirm the API matches by email correctly.
- Verify Vercel logs show the four expected log lines per successful checkout.

## Phased execution

Each phase ends with green tests + a working system. No phase leaves the system half-broken.

### Phase 1 — DB migration + repo

- Add `customer-login-tokens` schema to `packages/db`.
- Generate the drizzle migration.
- Implement `handoff-tokens.ts` repo methods: `mintToken`, `consumeToken`, `cleanExpired`.
- Unit tests against PGlite.
- Commit. Migrations are append-only and idempotent; the table is unused at this point.

### Phase 2 — API routes

- Add `WP_HANDOFF_SHARED_SECRET` to `apps/api/src/config.ts` as optional (so dev doesn't require it).
- Implement `routes/wc-handoff.ts` with `mint` + `verify`.
- Reuse `processWcOrderWebhook` for inline processing.
- Reuse `setCustomerCookie` from `routes/customer-auth.ts` (extract to a shared helper if it isn't already).
- Wire route into `app.ts`.
- Integration tests above.
- Set `WP_HANDOFF_SHARED_SECRET` on memesh-api via Vercel dashboard.
- Deploy. Routes exist but no one calls them yet (WP plugin not installed).
- Smoke-test by calling `mint` from a local curl with the shared secret — confirm 200 + token.

### Phase 3 — Customer frontend route

- Create `apps/customer/src/customer/CheckoutComplete.tsx`.
- Hook into `App.tsx` so `?token=...` on `/checkout-complete` mounts it.
- Manual test: paste a manually-minted token from Phase 2's smoke-test into a URL, verify the flow end-to-end.
- Deploy memesh-customer.

### Phase 4 — WordPress plugin (brother gates this phase)

- Hand brother the PHP plugin file from this plan + the env var spec.
- Brother approves.
- Yoav installs the plugin on the WP staging site (if there is one) or live.
- Set `MEMESH_HANDOFF_SECRET` on the WP host env (same value as `WP_HANDOFF_SHARED_SECRET` on Vercel).
- Place a real test order, confirm the full flow.
- Promote to production when green.

### Phase 5 — Verify + clean up

- Manual QA per the section above.
- Add a daily cleanup of expired tokens (cron, lives on memesh-api, deletes rows with `expires_at < now() - interval '7 days' AND consumed_at IS NULL`).
- Update `memesh-brief-v3.md` to reflect the new flow.

---

## Risks, ranked (rule 12 honest take)

1. **Token leaks via referer / analytics on the WP thank-you page.** When the redirect fires, the customer's browser may send a Referer header to any third-party scripts WP has loaded (Google Analytics, Facebook Pixel, etc.) containing the `https://my.memesh.co.il/checkout-complete?token=...` URL. The token is single-use so the practical risk is bounded, but it's still ugly. **Mitigation:** the WP plugin uses `window.location.replace` instead of an HTTP 302, so the previous page's referer is what gets sent, not the new URL. Verify in DevTools that no third-party network call carries the token. If any do, add a CSP `referrer` directive on the WP page.

2. **Inline `processWcOrderWebhook` slow path.** Right now the live WC webhook processor runs async after WC fires it. If we run it inline at mint time, the customer is sitting on a blank WP redirect waiting for our API to finish a DB write. **Mitigation:** target <800ms for the mint endpoint p95. The processor is mostly one customer insert + one card insert + one cron-log insert — fast. Set a Vercel function timeout of 8s. If the customer doesn't see a redirect in 8s, WP's plugin falls through to the default thank-you page.

3. **WC sends two webhooks (live + reconciliation) plus a mint call.** All three may attempt to create the same customer+card. The idempotency design of `processWcOrderWebhook` already handles this — there's a unique constraint on `wc_processed_webhooks(deliveryId)` and the customer/card lookups are read-then-insert. Verified in tests but worth one more manual e2e check.

4. **Shared secret rotation.** When we rotate `WP_HANDOFF_SHARED_SECRET`, there's a window where Vercel has the new value but WP still has the old one. **Mitigation:** the verify code accepts `[currentSecret, previousSecret]` for 24h after a rotation, controlled by a second env var. Built in from day one even though we rarely rotate.

5. **Brother says no.** This whole plan presumes brother signs off on the WP plugin. If he wants a different approach on the WP side (e.g., have WC redirect to a custom URL with order ID, do the mint server-side from a different surface), the API + frontend pieces still apply — only Phase 4 changes. Document this as the dependency it is.

6. **OTP fallback UX is the safety net.** Every failure mode this plan considers ends with "fall back to OTP login." That fallback only works if OTP works. It does today (Phase 6 verified) but is gated by Pulseem's sender-ID regulatory approval (separate plan). Until then, the OTP fallback delivers to spam folders. The handoff being the happy path *masks* this until something breaks; the OTP issue is a follow-up regardless.

Brutally honest take: this is straightforward to build (~3-4 days of work including the WP plugin), but the bug-hunt zone is around #1 (referer leaks) and #2 (inline processing latency). The DB + API + frontend pieces are 200 lines of code and a migration. The investigation work is in the integration testing across WP → API → frontend.

## Acceptance criteria

- A test order placed on the WP site results in the customer landing on `my.memesh.co.il/` (NOT `/checkout-complete`) signed-in within 2 seconds of "place order" success.
- The newly bought card is visible on the personal area immediately.
- Refreshing the page keeps them signed in (cookie set correctly).
- Visiting the original `/checkout-complete?token=...` URL via browser history → falls back to OTP login (token consumed).
- WP plugin error during mint (e.g., API down) → customer sees the default WC thank-you page; no broken redirect.
- Manual replay of a consumed token via curl returns 401 `invalid_or_consumed_token`.
- 90% of expired tokens are reaped by the daily cleanup cron.
- 4 namespaced log lines per successful handoff appear in Vercel runtime logs and correlate cleanly.

## Open question for brother

- **Hook choice on the WP side**: `woocommerce_thankyou` vs `woocommerce_order_status_processing` vs `woocommerce_payment_complete`. The first is the simplest; the third is the most defensible if you want server-side redirect semantics. He owns this call.
