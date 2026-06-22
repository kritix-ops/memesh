# SMS short link — Pattern B

**Date:** 2026-06-22
**Author:** Claude (Opus 4.7) for Yoav (Flexelent), driven by Yanay's "make
the URL shorter / less visually dominant" UX feedback after the WC
post-purchase SMS shipped earlier today (commits 018e9b3 + 696d78c).

## Goal

Cut the visible SMS URL from ~92 chars to ~41 chars on `my.memesh.co.il`,
without going through any third-party shortener (auth-token-in-URL +
spam-filter + trust-signal concerns). The wording immediately before the
URL is also updated to "לצפייה באזור האישי:" so the call-to-action lines
up with the personal-area destination.

Applies symmetrically to both post-sale SMS paths (POS via cards.ts and
WC via wc-post-purchase-sms.ts) — they share the same body builder and
the same `mintHandoffToken` call.

## Why this is "Pattern B" and not a `short_links` table

Either approach lands the user on `my.memesh.co.il/c/<x>`. Pattern A
(separate `short_links(code, target_token)` table) costs ~2 hours, a
schema migration, a new consume primitive, and a cleanup cron — for a
URL that's ~6 chars shorter than Pattern B. Pattern B reuses the
existing `customer_login_tokens` row by reducing the token's entropy
from 256 bits to 96 bits, which is still well above the threshold for a
single-use, 24h-TTL token against a rate-limited verify endpoint.

Pattern A's only real win is the option to have shorter codes than the
auth-token's entropy floor would allow. We don't need that.

## Security: dropping the handoff token to 96 bits

| Token bytes | Visible chars (base64url) | Bits | Year-to-guess (rate-limited 10/min × 100 valid tokens) |
|---|---|---|---|
| 32 (current) | 43 | 256 | heat-death |
| **12 (proposed)** | **16** | **96** | **~10²² years** |
| 8 | 11 | 64 | ~10¹⁰ years (still safe but no headroom) |

NIST SP 800-63B's "high authentication" threshold is ≥64 bits for
single-use tokens. 96 bits is solidly above that, and the single-use +
24h TTL + rate-limited consume endpoint already do most of the work.

No threat-model change vs today.

## URL shape

Before:
```
https://my.memesh.co.il/checkout-complete?token=CusySyUHmKFbzeqY4lpO3qfXwmlT9U9DpQNnc_Id...
└── 23 chars ──────────┘└────── 26 chars ──────┘└──────────────── 43 chars ────────────────┘
            base                  path                              token
```
Total: **92 chars**

After:
```
https://my.memesh.co.il/c/AbCdEfGhIjKlMnOp
└── 23 chars ──────────┘└── 3 ─┘└── 16 ──┘
            base           path     token
```
Total: **42 chars**

SMS segment win at Hebrew unicode (67 chars/segment for multi-part):
- Before: ~110-char body → 2-3 segments depending on body length
- After: ~85-char body → 2 segments
- Likely 1 fewer segment per send = ~30% Pulseem cost reduction over time

## Implementation steps

### 1. Shorten the token

`packages/db/src/handoff-tokens.ts`:

```ts
export const generateRawHandoffToken = (): { raw: string; hash: string } => {
  // 12 bytes = 96 bits of entropy → 16-char base64url. See
  // _plans/2026-06-22-sms-short-link.md for the security analysis.
  const raw = randomBytes(12).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
};
```

The hash column in `customer_login_tokens` stores a 64-char SHA-256 hex
regardless of input length, so no schema change.

### 2. Loosen the verify schema

`apps/api/src/routes/wc-handoff.ts:63`:

```ts
const verifySchema = z.object({
  token: z.string().min(12).max(100),  // was min(20)
});
```

Tolerates both the new 16-char tokens and any existing 43-char tokens
in flight during the deploy window.

### 3. Add `/c/:token` to the customer app

`apps/customer/src/App.tsx`:

```ts
const isCheckoutComplete = (): boolean => {
  if (typeof window === 'undefined') return false;
  const p = window.location.pathname;
  // Two shapes share the same CheckoutComplete component:
  //   /checkout-complete?token=<token>  — WP browser-redirect (legacy)
  //   /c/<token>                        — SMS magic link (current)
  return p === '/checkout-complete' || /^\/c\/[A-Za-z0-9_-]+\/?$/.test(p);
};
```

`apps/customer/src/customer/CheckoutComplete.tsx` — extract the token from
either the query string OR the path:

```ts
const readToken = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('token');
  if (fromQuery) return fromQuery;
  const m = window.location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : null;
};
```

The existing `history.replaceState({}, '', '/checkout-complete')` scrub
moves to `'/'` (since the page no longer needs to live at
`/checkout-complete` once the token is consumed — that path was an
artifact of the URL-as-state pattern, not a destination the user types).

### 4. Switch SMS link builders to /c/<token>

Two call sites:
- `apps/api/src/routes/cards.ts` (POS post-sale SMS) — line ~236:
  `${env.CUSTOMER_BASE_URL}/checkout-complete?token=${minted.raw}` →
  `${env.CUSTOMER_BASE_URL}/c/${minted.raw}`
- `apps/api/src/lib/wc-post-purchase-sms.ts` (WC webhook SMS) — same swap.

### 5. SMS body wording tweak

`apps/api/src/lib/post-sale-sms.ts`:

```ts
// single-card body
`הכרטיסייה שלך ב-Memesh נוצרה! ${totalEntries} כניסות${expiry}. לצפייה באזור האישי: ${link}`

// multi-card body
`נוצרו ${N} כרטיסיות חדשות ב-Memesh! לצפייה באזור האישי: ${link}`
```

The multi-card body already uses "לצפייה באזור האישי" so we only change
the single-card body.

### 6. Bonus: Referrer-Policy: no-referrer on the token-bearing pages

`apps/customer` is a Vite SPA served by Vercel. Easiest way to attach the
header is via a `<meta name="referrer" content="no-referrer">` in
`apps/customer/index.html` (or a per-route `<Head>` if we use one).
Stops cross-origin resources loaded on the page (fonts, analytics, the
shop-site logo link) from leaking the token in the Referer header.

Effort: ~2 lines. Closes a pre-existing exposure that the current long-URL
flow also has.

### 7. Tests

Update assertions:
- `packages/db/src/handoff-tokens.test.ts` lines 41 + 70: `assert.equal(raw.length, 43)` → `16`. Also the regex `^[A-Za-z0-9_-]+$` still passes for base64url at any length.
- `apps/api/src/lib/post-sale-sms.test.ts`: update all body-text assertions that include the "צפייה בכרטיסייה:" wording → "לצפייה באזור האישי:". (The multi-card test already uses the new wording.)
- `apps/api/src/lib/wc-post-purchase-sms.test.ts`: update the URL regex to match `/c/` instead of `/checkout-complete?token=`.

### 8. Backwards compat audit

| Surface | What it sees | After this change |
|---|---|---|
| In-flight SMS magic links (43-char tokens, /checkout-complete path) | `/checkout-complete?token=<43>` | Works — route preserved, schema accepts |
| WP browser-redirect after WC checkout | `/checkout-complete?token=<43>` | Works — WP plugin unchanged |
| In-flight 43-char tokens in `customer_login_tokens` | hash-only stored | Works — hash column is length-agnostic |
| Future SMS magic links | `/c/<16>` | New path, new handler in same component |
| `verify` endpoint rate-limit bucket | same path, same handler | No change |

### 9. Observability

Existing `[wc post-sale]` / `[cards post-sale]` log lines remain. The
existing `console.info('[checkout-complete] exchanging token',
{ tokenLength })` in CheckoutComplete.tsx now logs 16 instead of 43 —
useful as a deploy-window signal (the first 16 in the logs means a new
token successfully made it through the new path).

### 10. Settings audit (Rule 15)

No new settings. The wording tweak is hardcoded — a strict reading of
rule 15 says "the operator might want to control this" but the same
applies to every Hebrew string in the codebase, and Yanay has not asked
for SMS-template-editing in admin. If they do, that's a separate plan
that surfaces `checkoutSmsBody` like the existing `checkoutThankyouTitle`.
Out of scope here.

## QA pass

1. **Golden POS path**: create a cashier-driven card with `smsOnPurchase=true` → SMS in `console` provider shows `/c/<16chars>` body and "לצפייה באזור האישי:" wording. Tap the link → CheckoutComplete page → cookie set → personal area visible.
2. **Golden WC path**: send a WC webhook → same SMS shape → tap link → same outcome.
3. **Legacy long-URL still works**: simulate a customer with an in-flight 43-char token → `/checkout-complete?token=<43>` → cookie set → personal area.
4. **Garbage path**: `/c/!@#$` → CheckoutComplete loads, reads no token (regex fails), shows "no_token" error state with OTP fallback CTA.
5. **HTTPS prod guard**: still holds (config.ts superRefine unchanged).
6. **Referrer leak**: load `/c/<token>` in a browser, inspect the Network panel — outbound requests for fonts/etc. carry no `Referer` header.

## Out of scope

- WhatsApp Business migration (the discussion that surfaced this work — separate plan if/when we decide to go there).
- Pattern A's `short_links` table (rejected per the analysis above).
- WP plugin redirect-URL change (still uses `/checkout-complete?token=`, no user-visible benefit to changing, more deploy surface to coordinate).
- Admin-editable SMS body templates (out of rule 15 scope today; flag if Yanay asks).
