# Seller attribution + email fallback

**Status:** approved 2026-06-20 (Yoav, relaying Yanay).

## Source

WhatsApp feedback from Yanay (product owner) on 2026-06-20. Seven asks
covering anti-fraud tripwires on the cashier flow and an email-based login
fallback for customers when SMS is unavailable.

## Goal

Two related problems in one drop:

1. **Anti-fraud monitoring on POS sales.** Make it hard for a cashier to
   issue a punch card off-the-books (free pass to a friend), and make every
   suspect card trace back to a specific cashier and a recorded receipt
   number so Yanay can spot-check against the register tape.
2. **Email-based login fallback for customers.** When SMS fails (no signal,
   wrong number, telecom outage) and for customers who later change phone
   numbers, let them log in with their email instead. Mandatory email
   capture for WooCommerce orders so the fallback is actually usable.

## Locked decisions

| Question | Answer |
|---|---|
| Receipt number — required? | Yes, required on every `source = 'pos'` card. |
| Receipt number — unique? | Yes, DB unique constraint. Reusing the same number twice is the lazy version of the fraud and we catch it for free. |
| Receipt number — validated against AccuPOS? | **No.** Out of scope for this drop. Yanay monitors manually and verifies suspects against the register tape. Real reconciliation lands with the AccuPOS integration later. |
| "Name on receipt" checkbox — logged? | No. Pure UI speed-bump. Logging it would imply the system verified it, which it can't. |
| Cashier identification model | Per-sale PIN on top of existing phone+password login. PIN = attribution, not auth. (Option A from the design conversation.) |
| PIN length | 3 digits (Yanay's suggestion). Configurable via setting if we want to raise it later. |
| PIN remembered between sales? | Yes, 15 min sliding window per device session. "Switch cashier" button clears it. |
| PIN brute force | 5 wrong tries → cashier PIN locked for 15 min. Manager/admin can unlock from the admin staff page. |
| Email login — customer discovery? | **No.** Email must match `customers.email` exactly. No email on file → no email login. UI says "no email on file, contact support." |
| Email login mechanism | OTP code mirroring SMS flow (request → 6-digit code → verify). Not magic link — keeps the UX consistent across SMS and email. |
| Email provider | **Resend.** Free tier (3k emails/month, 100/day cap) covers OTP-fallback volume with massive headroom. See cost section. |
| WC orders — email required? | Yes. Reject with new `email_required` failure type if billing email missing. Cron will not retry the same payload — admin sees the failure row and fixes upstream. |
| Email nudge on POS form | Pure copy change next to the existing optional email input. |
| Performance dashboard (sales-by-cashier) | **Out of scope.** Next phase. We ship the data capture (`soldBy`, `receiptNumber`) now. |
| Admin PIN management for cashiers | Admin can: **generate** a random PIN, **manually set** a chosen PIN, **change** it, **delete** it. Cashier can also self-set their own PIN with fresh-auth gate. |
| Pre-rollout PIN setup | Confirmed — admins set initial PINs for all active cashiers before the requirement turns on. No grace window. |
| Settings defaults | All six new requirements ship **ON** by default (Yanay wants the controls live from day one). |
| Hebrew copy | Claude writes natural Hebrew defaults; the customer-facing strings (email subject + body, POS checkbox label, POS email nudge) are **editable from the admin Settings page**. System UI labels (field names, buttons, error messages) are hardcoded. |

## Brutally honest notes

- **The receipt number alone does not catch determined fraud.** A cashier
  who knows the system can type a plausible 5-digit number that doesn't
  exist on any real receipt and we'd never know without comparing against
  AccuPOS. This drop raises friction + builds the audit trail; the real
  catch happens when AccuPOS reconciliation lands. Yanay accepted this.
- **The "I wrote the name on the receipt" checkbox is enforcement theater.**
  Ticking it doesn't prove anything was written. It's a one-second pause
  designed to nudge the cashier toward the habit. We're shipping it
  because behavioral nudges are cheap and worth trying, but we're not
  pretending it's a control. We deliberately do not log it.
- **3-digit PIN is fine for attribution, not for auth.** 1,000 codes is
  brute-forceable. That's why the PIN does NOT replace phone+password
  login — it's just a "who at this register did this sale" stamp on top of
  an already-authenticated device session. The 5-strikes lockout keeps
  even the attribution from being faked at the till in real time.
- **Email-OTP fallback fails closed if no email on file.** Pre-existing
  customers without an email are stuck on SMS until someone (admin or
  themselves on the customer area) adds one. We accept this — it's strictly
  better than today, where there's no fallback at all.
- **Resend free tier has a 100/day cap.** OTP fallback volume should be
  far below this. If we ever do anything bulk over email, we hit the cap
  fast. Code MUST treat this as a transactional-only channel; marketing
  email goes through a different path (already SMS-only today).

## Cost — email provider selection

Pulled live 2026-06-20.

| Provider | Free tier | First paid tier | Per-extra-email |
|---|---|---|---|
| **Resend** | 3,000/mo, 100/day cap | $20/mo for 50k emails | $0.90 per 1k |
| Postmark | 100/mo (test only) | $15/mo for 10k emails | $1.80 per 1k |
| AWS SES | 3,000/mo for first year | $0.10 per 1k after | $0.10 per 1k |

**Recommendation: Resend, free tier.** Expected OTP volume is well under
3k/month (it's a fallback, not a primary channel). Resend's DX is the
best of the three (modern API, React Email templating, easy domain
setup). SES is cheaper at scale but the IAM + sandbox-approval friction
isn't worth it at our volume. Postmark's free tier is too small to be
useful and we'd be paying $15/mo from day one for no real benefit over
Resend free.

**Watch:** if email volume ever approaches 2k/month, revisit. If we
add transactional emails beyond OTP (receipts, marketing, etc.) the
choice may change.

## Data model

### New tables

1. **`staff_pins`** — hashed attribution PINs per cashier.
   ```
   id            uuid pk
   staff_id      uuid fk -> staff.id, unique  -- one PIN per staff
   pin_hash      varchar(255) not null         -- scrypt + pepper
   failed_count  integer not null default 0
   locked_until  timestamptz                   -- null = not locked
   created_at    timestamptz not null default now()
   updated_at    timestamptz not null default now()
   ```
   PIN-collision is intentionally allowed — two cashiers can pick the
   same 3-digit code (only 1000 options). What matters is which
   authenticated session entered it. The hash + lookup is per-cashier,
   not "find me the staff with PIN 123".

2. **`email_otps`** — mirrors `customer_otps`, keyed by email.
   ```
   id          uuid pk
   email       varchar(255) not null
   code_hash   varchar(128) not null
   expires_at  timestamptz not null
   attempts    integer not null default 0
   consumed_at timestamptz
   created_at  timestamptz not null default now()
   ```
   Index on `(email, created_at)` for rate-limit lookups.

### Extended tables

3. **`punch_cards`** — two new nullable columns (nullable for the
   migration; the API enforces "required for `source='pos'`" at the
   route layer so historical rows stay valid):
   ```
   receipt_number  varchar(64)
   sold_by         uuid fk -> staff.id
   ```
   Unique partial index on `receipt_number` WHERE `receipt_number IS
   NOT NULL` (so historical rows with NULL don't collide).

### Extended settings (`card_settings`)

4. New columns:
   ```
   require_receipt_number_on_pos  boolean default true
   require_seller_pin             boolean default true
   pin_length                     integer default 3
   pin_memory_minutes             integer default 15
   pin_max_failures               integer default 5
   pin_lockout_minutes            integer default 15

   -- Editable customer-facing copy. Defaults seeded with Hebrew strings;
   -- admin can override from the Settings page.
   pos_name_on_receipt_label      text not null default
     'רשמתי את שם הלקוח על הקבלה במעמד התשלום'
   pos_email_nudge_text           text not null default
     'האימייל לא חובה אך מומלץ — מאפשר ללקוח להיכנס לאזור האישי גם אם החליף מספר טלפון או אם ה-SMS לא יגיע.'
   email_otp_subject              text not null default
     'קוד הכניסה שלך לאזור האישי בממש'
   email_otp_body_template        text not null default
     'שלום {{firstName}},\n\nקוד הכניסה שלך הוא: {{code}}\n\nהקוד תקף ל-10 דקות.\nאם לא ביקשת קוד זה, אפשר להתעלם מההודעה.\n\nצוות ממש'
   ```
   Template variables: `{{firstName}}` (falls back to "לקוח/ה" if
   missing) and `{{code}}`. Renderer rejects unknown variables at
   admin-save time so a typo doesn't silently break OTPs in
   production.

## Backend

### db (`@memesh/db`)

1. **`setStaffPin(db, { staffId, pin, pepper })`** — scrypt-hash the PIN
   with the server pepper, upsert by `staff_id`, reset `failed_count`
   and `locked_until`. Returns `{ ok: true }`.
2. **`verifyStaffPin(db, { staffId, pin, pepper, now })`** —
   - 404 if no PIN set for that staff
   - 423 (locked) if `locked_until > now`
   - constant-time compare; on success reset `failed_count` and return
     `{ ok: true }`
   - on failure increment `failed_count`; if `failed_count >=
     settings.pin_max_failures` set `locked_until = now +
     settings.pin_lockout_minutes` and return `{ ok: false, reason:
     'locked', retryAfterSec }`
   - else return `{ ok: false, reason: 'invalid_pin' }`
3. **`unlockStaffPin(db, { staffId, byStaffId })`** — clear
   `locked_until` and `failed_count`. Logs a `staff_action` row of type
   `'pin_unlock'`.
4. **`requestEmailOtp(db, email, { pepper })`** — mirror
   `requestOtp`. Returns `{ sent: true, code }` or `{ sent: false,
   reason }` (rate-limited / not a known customer email — but the route
   always responds the same to the client).
5. **`verifyEmailOtp(db, email, code, { pepper })`** — mirror
   `verifyOtp`. Returns `{ ok: true, customerId }` or `{ ok: false,
   reason }`.
6. **Extend `createPunchCard`** to accept `receiptNumber?: string` and
   `soldBy?: string` and write them through. Reject (DB-level) duplicate
   `receipt_number`.
7. **Extend `getCardSettings`** result type for the six new fields.

### API (`apps/api`)

1. **`POST /cards`** (existing route, modify):
   - Body now includes `receiptNumber: string (min 1, max 64)` and
     `sellerPin: string (digits, configurable length)`.
   - If `settings.requireReceiptNumberOnPos` and `source = 'pos'`: reject
     400 `receipt_number_required` when missing.
   - If `settings.requireSellerPin`: verify PIN via
     `verifyStaffPin(staffId = request.user.id, pin)`. Map failures:
     - `locked` → 423 `pin_locked` `{ retryAfterSec }`
     - `invalid_pin` → 401 `invalid_pin`
   - On DB unique violation on `receipt_number`: 409
     `receipt_number_duplicate`.
   - Pass `receiptNumber` + `soldBy = request.user.id` into
     `createPunchCard`.
2. **`POST /admin/cards`** (existing admin-create): no changes — admin
   gift/manual cards don't get a receipt number or seller PIN.
3. **`POST /staff/:id/pin`** (new, admin/manager only) — set or reset
   a cashier's PIN. Body `{ pin: string }`. Logs `staff_action` type
   `'pin_set'`. Cashiers can also set their own PIN via
   `POST /me/pin` (no admin gate, but requires fresh auth — last login
   within 15 min, otherwise 401 `reauth_required`).
4. **`POST /staff/:id/pin/unlock`** (new, admin/manager only) — clears
   lockout. Logs `staff_action` type `'pin_unlock'`.
5. **`POST /auth/customer/request-email-otp`** (new, mirrors SMS):
   - Body `{ email: string }`
   - Rate limit 5/min/IP
   - Always returns `{ ok: true }` — never reveals whether the email is
     known. Internally: look up `customers.email = ?`; if found,
     generate code, store hash in `email_otps`, send via Resend.
6. **`POST /auth/customer/verify-email-otp`** (new, mirrors SMS):
   - Body `{ email: string, code: string }`
   - Rate limit 10/min/IP
   - On success: same cookie + session as SMS verify.
7. **`POST /auth/customer/logout`** — no change.
8. **`wc-order-processor.ts`**: when `billing.email` is missing or
   empty, record a `wc_webhook_failures` row with new
   `reason: 'email_required'` and return `{ status: 'failure', reason:
   'email_required', orderId }`. The route maps this to a 200 response
   (so WC doesn't retry forever) and logs at warn level. Admin sees the
   failure in the WC failures panel and fixes the order upstream (then
   the cron reconciliation picks it up).

### Email transport (`packages/email`, new package)

Match the shape of `packages/sms` (which `apps/api/src/lib/sms.ts`
wraps).

1. **`EmailProvider`** interface:
   ```ts
   send(input: { to: string; subject: string; html: string; text?: string }):
     Promise<{ providerMessageId: string }>
   ```
2. **`ResendEmailProvider`** implementation:
   - Constructor takes `{ apiKey, from }`
   - Uses Resend's REST API directly (single `fetch` call; no SDK
     dependency unless Context7 says otherwise when implementing).
   - Throws on non-2xx with the Resend error code in the message.
3. **`NoopEmailProvider`** — for dev / when no API key configured.
   Logs the email payload at info level and returns a fake id. Same
   pattern as the SMS noop.
4. **Factory** picks based on `env.EMAIL_PROVIDER` (`'resend'` |
   `'noop'`, default `'noop'`).

### Env vars (`apps/api/src/config.ts`)

```
EMAIL_PROVIDER     # 'resend' | 'noop', default 'noop'
RESEND_API_KEY     # required when EMAIL_PROVIDER='resend'
EMAIL_FROM         # e.g. "Memesh <noreply@memesh.co.il>"
```

Add to `.env.example` and the README env table.

## Frontend

### POS (`apps/web/src/pos`)

1. **`SellCardModal`** (or wherever the sell flow lives):
   - New input: **"מספר קבלה"** (receipt number), required when
     `settings.requireReceiptNumberOnPos`. Numeric input, autoComplete
     off. Validates non-empty before submit.
   - New checkbox: **"רשמתי את שם הלקוח על הקבלה במעמד התשלום"**
     ("I wrote the customer's name on the receipt at the time of
     payment"). Required to enable the Submit button.
   - On submit, if a PIN is required and not in session memory: open
     a **PIN modal** that takes focus, shows the cashier's name ("היי
     {{firstName}}, הזן את הקוד האישי שלך"), captures the digits, and
     submits. On 401 invalid_pin: shake + clear + error toast. On 423
     pin_locked: clear + lockout message with countdown.
   - On 409 `receipt_number_duplicate`: inline error on the receipt
     field, "מספר זה כבר משויך לכרטיסייה אחרת — בדוק את הקבלה."
2. **PIN session memory** — small in-memory module keyed by `staffId`:
   `{ pin, lastUsedAt }`. Sliding window: refresh on every successful
   use. Expires after `settings.pinMemoryMinutes`. Cleared on logout
   and on "Switch cashier" button click. **Never persisted** — not in
   localStorage, not in sessionStorage, not in cookies. Lives only in
   the running tab.
3. **"Switch cashier"** button in the POS header — clears PIN session
   memory and shows a brief toast "הקוד נמחק. הקופאי הבא יזין את הקוד
   שלו בעסקה הבאה."
4. **Email field nudge** on the new-customer form: small caption under
   the optional email input —
   "אימייל לא חובה, אבל מומלץ — מאפשר ללקוח להיכנס לאזור האישי גם אם
   יחליף מספר טלפון או שה-SMS לא יגיע."

### Customer area (`apps/web/src/customer`)

1. **Login screen**:
   - Primary path: SMS (unchanged).
   - Below the SMS form: text link **"לא קיבלתי SMS — להתחבר באימייל"**
     → switches the form to email input.
   - Email input → request OTP → 6-digit code input → verify. Same
     visual treatment as the SMS code step.
   - If `verifyEmailOtp` fails: generic "קוד שגוי או פג תוקף" message.
     Never reveal whether the email was known.
2. **"Switch back to SMS"** link on the email-code step.

### Admin (`apps/web/src/admin`)

1. **Staff list page** (`Staff.tsx` or equivalent):
   - New column / row affordance per cashier showing PIN status: "הוגדר"
     / "לא הוגדר" / "נעול עד {{time}}".
   - **"איפוס קוד אישי"** button (admin/manager only) → prompts for a
     new 3-digit code → calls `POST /staff/:id/pin`.
   - **"שחרור נעילה"** button when locked → calls `POST /staff/:id/pin/unlock`.
2. **Self-service PIN page** (`/me/pin`): cashier sets/updates their
   own PIN. Requires fresh auth (re-enter password if last login > 15
   min ago).
3. **Settings page** (`Settings.tsx`): six new toggles in a new "קופה
   ובקרה" group:
   - "חובה למלא מספר קבלה" (toggle)
   - "חובה להזין קוד אישי בכל עסקה" (toggle)
   - "אורך הקוד האישי" (number, 3–6)
   - "זמן זיכרון של הקוד האישי בדקות" (number, 1–60)
   - "כשלים מותרים לפני נעילת קוד" (number, 1–10)
   - "משך נעילה בדקות" (number, 1–60)

## Security

1. **PIN hashing** — scrypt with the existing `SERVER_SECRET_KEY` as
   pepper, same as customer-OTP hashing. Never stored or logged in
   plaintext. Even though 3 digits is low-entropy, peppered scrypt
   makes a DB-leak attacker pay full cost per guess.
2. **PIN brute-force lockout** — 5 strikes per cashier → 15-min
   lockout. Lockout is per-staff-id, not per-device — moving to
   another till won't help an attacker.
3. **PIN never echoed in HTTP** — the response on a wrong PIN doesn't
   include `failed_count` or `retryAfterSec` until lockout fires; this
   prevents a remote attacker from knowing exactly how close they are.
4. **PIN session memory in-tab only** — never persisted, cleared on
   logout, cleared on tab close. A stolen device with a dead session
   does not retain PINs.
5. **Email-OTP rate limits** — 5/min/IP for request, 10/min/IP for
   verify. Same opaque-response pattern as SMS (always 200 OK on
   request, never reveal whether the email is known).
6. **Email-OTP brute force** — `email_otps.attempts` increments on
   each wrong code; after 5 the row is invalidated (consumedAt set to
   now, forcing a new request). Same pattern as the existing SMS OTP.
7. **Email-OTP code length** — 6 digits (matches SMS). Codes expire
   after 10 minutes. Hashed at rest with the same pepper.
8. **`RESEND_API_KEY`** stored in env vars only, never logged, never
   committed. Add to `.env.example` as a placeholder.
9. **Receipt number uniqueness at the DB level**, not just at the API
   level — the partial unique index is the source of truth. The API
   produces a clean 409, but even a direct DB write can't violate the
   constraint.
10. **PIN-unlock is an audited action** — `staff_actions` row of type
    `'pin_unlock'` records who unlocked whom and when.
11. **Fresh-auth gate on self-service PIN change** — a stolen-and-logged-in
    session can't silently rotate the PIN; user re-enters password if
    their last login was > 15 min ago.
12. **`email_otps` does NOT leak existence** — the request route always
    responds `{ ok: true }` whether the email is known, throttled, or
    completely unknown. Internally, we only enqueue the email when the
    address matches a `customers.email`.

## Observability

Namespaces (matches the existing `[scope verb]` convention):

- `[pos sell]` — receipt number, soldBy, source, customer number, success/failure
- `[auth pin set]` — staffId, byStaffId (self or admin)
- `[auth pin verify]` — staffId, success boolean, failed_count_after,
  locked boolean. **Never logs the PIN itself.**
- `[auth pin unlock]` — staffId, byStaffId
- `[email otp request]` — email-hash (sha256 first 8 chars, not the
  email itself), known_email boolean, sent boolean
- `[email otp verify]` — email-hash, success boolean, attempts_after
- `[email provider resend]` — providerMessageId on success, error code
  on failure
- `[wc order email-required]` — orderId, deliveryId — when a WC order
  is rejected for missing email

All log lines use `request.log.info` (or `.warn` for failures /
unusual paths) with structured fields. Boolean values logged
explicitly (per rule 14 — booleans without values give nothing to
diagnose).

## Settings

New "קופה ובקרה" group on the admin Settings page. All six controls
listed above ship visible by default. Deliberately NOT exposed (and
why):

- **"זמן תפוגה של קוד אימייל בדקות"** — hardcoded to 10. Standard for
  OTP; exposing it just creates a footgun.
- **"מספר ספרות בקוד OTP אימייל"** — hardcoded to 6. Same reasoning.
- **"ספק האימייל"** — env-var only, not a runtime setting. Switching
  providers is a deploy-time decision.

## Testing

### Unit (`packages/db`)

1. `setStaffPin` + `verifyStaffPin` — happy path, wrong PIN, lockout
   after 5 wrong, lockout expiry, unlock clears lockout.
2. `requestEmailOtp` + `verifyEmailOtp` — happy path, unknown email
   returns `sent: false`, expired code rejected, wrong code increments
   attempts, 5 wrong codes invalidates the row.
3. `createPunchCard` with `receiptNumber` + `soldBy` — stored
   correctly. Duplicate `receiptNumber` rejected by DB unique
   constraint.

### Unit (`apps/api`)

4. `POST /cards` — `receipt_number_required` when missing and setting
   on, `pin_locked` 423 when PIN is locked, `receipt_number_duplicate`
   409 on duplicate, success path stores the row.
5. `POST /auth/customer/request-email-otp` — always 200, only sends
   when email is in `customers.email`.
6. `POST /auth/customer/verify-email-otp` — success issues cookie,
   failure returns generic invalid_code.
7. `wc-order-processor` — order without `billing.email` records a
   `wc_webhook_failures` row with reason `'email_required'` and
   returns the failure result (existing
   `wc-order-processor.test.ts` extended).

### Integration (`apps/api`)

8. Full POS sell flow: login → set PIN → sell card with PIN + receipt
   number → verify card row has `sold_by` + `receipt_number`. Second
   sell with the same receipt number → 409.

### Out of scope for tests

- Real Resend HTTP calls (use the NoopEmailProvider in tests).
- Real WooCommerce checkout form (we trust WC's email-required
  checkout setting; we just enforce on our side as defense in depth).
- Frontend component tests for the PIN modal — covered by manual QA
  in the POS golden-path checklist.

## Migration plan

1. Drizzle migration adds the two columns to `punch_cards` (nullable),
   the `staff_pins` and `email_otps` tables, the six settings columns,
   and the partial unique index on `receipt_number`.
2. Settings columns default to enabling all new requirements
   immediately. Yanay accepts that we'll have a transition period
   where existing cashiers need to set PINs before they can sell.
3. **Pre-rollout step**: admin runs through all active cashiers and
   sets initial PINs (via `POST /staff/:id/pin`) so no one is locked
   out at first sale.
4. Email provider env vars: deploy with `EMAIL_PROVIDER=noop` first,
   then flip to `resend` once the Resend account + domain DKIM is
   verified.

## Out of scope (followups)

- AccuPOS reconciliation for receipt numbers (separate plan, queued
  with the broader AccuPOS integration).
- Sales-by-cashier performance dashboard (next phase per Yanay).
- Email-based customer record discovery / merge tools.
- Marketing emails (today: SMS only; if we add this, Resend free tier
  may not be enough — revisit then).
- PIN rotation policy / forced periodic change. Manual change via
  admin or self-service is enough for now.
- Custom Resend templates / React Email layouts — start with plain HTML
  + text body for the OTP message.

## Open items before merge

- [ ] Confirm Memesh-owned domain for Resend `EMAIL_FROM` (probably
      `noreply@memesh.co.il`) and verify DKIM/SPF.
- [ ] Decide on the exact Hebrew copy for the OTP email body and the
      "name on receipt" checkbox label (Yanay can polish).
- [ ] Confirm WooCommerce checkout already enforces email as required
      (it does by default; verify it's not been disabled on
      memesh.co.il).
