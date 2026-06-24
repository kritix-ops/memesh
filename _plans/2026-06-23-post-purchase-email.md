# Post-purchase email notification

**Date:** 2026-06-23
**Author:** Claude (Opus 4.7) for Yoav (Flexelent)
**Status:** Draft — implementing immediately per "work without stopping" mode.
**Builds on:** the WC + POS post-purchase SMS work shipped 2026-06-22
(commits 018e9b3, 70e0dd2) and the SMS short-link work (fcca000).

## Goal

When a customer's card is created (POS sale, WC online purchase via webhook,
or via the inline wc-handoff/mint path), they receive a **post-purchase
email** in addition to the existing SMS — confirming the purchase and
embedding the same kind of magic link into the personal area.

Both channels go out when both addresses (phone + email) are available.
The customer can tap either. Independent tokens, single-use each.

## Why email in addition to SMS

- **Receipt of record.** SMS is ephemeral; email sticks around in inboxes.
- **Reaches the customer where they read longer-form content** (laptop, desktop, when traveling without phone signal).
- **Searchable.** "Memesh כרטיסייה" in inbox search returns the right thing months later.
- **Defence-in-depth.** If SMS is blocked, dropped, or the number is wrong, email is the fallback.

## Channel + token decisions (locked with user 2026-06-23)

| Question | Decision |
|---|---|
| Provider | Pulseem (build new provider; vendor consolidation with the existing SMS account) |
| Channels | Both SMS and email, when both addresses available |
| Tokens | Mint TWO tokens per purchase (one per channel). Each is single-use, customer can tap either without "already used" friction |

## Architecture

```
                            ┌─────────────────────────────┐
                            │  cards.ts (POS sell route)  │
                            │  webhooks-wc.ts (WC webhook)│
                            │  wc-handoff.ts (mint route) │
                            └─────────────┬───────────────┘
                                          │ on cardsCreated.length > 0
                          ┌───────────────┼───────────────┐
                          ▼                               ▼
              ┌───────────────────────┐       ┌───────────────────────┐
              │ fireWcPostPurchaseSms │       │ firePostPurchaseEmail │
              │ (exists today)        │       │ (NEW)                 │
              │ mints token #1        │       │ mints token #2        │
              │ smsProvider.send()    │       │ emailProvider.send()  │
              └───────────────────────┘       └───────────────────────┘
                          │                               │
                          ▼                               ▼
                  Pulseem SMS API                  Pulseem Email API
                  (existing)                       (NEW provider)
```

## Pulseem email API (verified via swagger 2026-06-23)

- **Endpoint:** `POST /api/v1/EmailApi/SendEmail`
- **Auth:** `APIKEY` header (same as SMS — the documented `X-Api-Key` doesn't work; confirmed by their support 2026-06-21 for the SMS path; same server so same auth)
- **Body shape** (parallel-array pattern matching their SMS API):
  ```json
  {
    "sendId": "<uuid>",
    "isAsync": false,
    "emailSendData": {
      "fromEmail": "noreply@memesh.co.il",
      "fromName": "Memesh",
      "subject": ["הכרטיסייה שלך ב-Memesh מוכנה"],
      "html":    ["<html>...</html>"],
      "toEmails": ["customer@example.com"],
      "toNames":  ["שם הלקוח"],
      "externalRef": ["<our reference>"]
    }
  }
  ```
- **Constraint:** Pulseem accepts `html` only — no `text` field. We send HTML; modern clients render fine, text-only clients fall back to HTML stripping.
- **Response:** 200 success, 500 server error. Same defensive parsing as SMS.

## Implementation plan

### 1. New `PulseemEmailProvider` in `@memesh/email`

`packages/email/src/pulseem-email-provider.ts`. Same shape as the existing
SMS provider:

```ts
export interface PulseemEmailOptions {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class PulseemEmailProvider implements EmailProvider {
  readonly name = 'pulseem';
  async send(message: EmailMessage): Promise<EmailSendResult> { ... }
}
```

Plus `pulseem-email-provider.test.ts` mirroring the SMS test shape.

### 2. Config

`apps/api/src/config.ts`:
- `EMAIL_PROVIDER` enum: add `'pulseem'`
- Reuse `PULSEEM_API_KEY` (same Pulseem account)
- Add `PULSEEM_EMAIL_FROM_EMAIL` + `PULSEEM_EMAIL_FROM_NAME` for sender identity
- `EMAIL_FROM` stays only for Resend
- `apps/api/src/lib/email.ts` createEmailProvider() picks `PulseemEmailProvider` when `EMAIL_PROVIDER=pulseem`

### 3. New `card_settings.email_on_purchase` flag

Migration `0012_email_on_purchase.sql`:
```sql
ALTER TABLE card_settings ADD COLUMN email_on_purchase boolean NOT NULL DEFAULT true;
```

Drizzle schema update + getCardSettings + updateCardSettings.
Admin Settings page gets a new toggle next to `smsOnPurchase`.

For v1: subject line + HTML body are hardcoded (matching the SMS pattern
where the body is hardcoded). Future enhancement: admin-editable subject
via `email_on_purchase_subject` text column. Out of scope today per the
"don't add features beyond what the task requires" rule.

### 4. `firePostPurchaseEmail` helper

`apps/api/src/lib/post-purchase-email.ts`. Mirrors `fireWcPostPurchaseSms`:

- Skip if `customer.email` is null (silent, info-log)
- Skip if `settings.emailOnPurchase === false` (info-log)
- Mint a NEW handoff token (separate from the SMS one)
- Build the magic link `${env.CUSTOMER_BASE_URL}/c/${token}`
- Build Hebrew RTL HTML body (see template below)
- Call `emailProvider.send({ to, subject, html, text })`
- Fire-and-log; never throws

### 5. Wire the helper into 3 routes

| Route | Today | After |
|---|---|---|
| `apps/api/src/routes/webhooks-wc.ts` case `'processed'` | fires SMS | fires SMS + email in parallel |
| `apps/api/src/routes/wc-handoff.ts` mint inline-processor | fires SMS | fires SMS + email in parallel |
| `apps/api/src/routes/cards.ts` POS sell post-block | fires SMS | fires SMS + email in parallel |

Both calls are `void` async (fire-and-log, don't block the route response).

### 6. Email body

Hebrew RTL HTML, brand-aligned (cream background `#fff8f1`, Memesh
salmon `#f6a96e`, generous spacing per rule 16 UI/UX standards). Plain
text version for accessibility but Pulseem only accepts HTML so the
text-only fallback is what the HTML degrades to in stripped form.

Single-card body (matches the SMS pattern with richer structure):

```html
<div dir="rtl" lang="he" style="font-family: 'Assistant', sans-serif; background: #fff8f1; padding: 32px;">
  <table role="presentation" style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 32px;">
    <tr><td>
      <h1 style="color: #2d3436; font-weight: 700;">הכרטיסייה שלך מוכנה! 🎉</h1>
      <p>שלום {firstName},</p>
      <p>הכרטיסייה החדשה שלך ב-Memesh נוצרה.</p>
      <p><strong>{totalEntries} כניסות{expiryClause}</strong></p>
      <p style="text-align: center; margin-top: 24px;">
        <a href="{link}" style="background: #f6a96e; color: #fff; padding: 12px 32px; border-radius: 12px; text-decoration: none; font-weight: 700;">
          לצפייה באזור האישי
        </a>
      </p>
      <p style="color: #888; font-size: 12px; margin-top: 32px;">
        אם הכפתור לא עובד, העתיקו את הקישור: {link}
      </p>
    </td></tr>
  </table>
</div>
```

Multi-card variant: same skeleton, body says "נוצרו N כרטיסיות חדשות" instead of the count+expiry.

Subject: `"הכרטיסייה שלך ב-Memesh מוכנה"` (single) or `"N כרטיסיות חדשות ב-Memesh"` (multi).

### 7. Tests

- `packages/email/src/pulseem-email-provider.test.ts` — mock fetch, verify endpoint, header, body shape, success/error paths
- `apps/api/src/lib/post-purchase-email.test.ts` — PGlite-backed, mirrors the SMS helper test:
  - golden path: mints token, sends email
  - emailOnPurchase=false → no send
  - customer with no email → no send
  - multi-card body shape
  - FK failure doesn't throw

### 8. env.example updates

`apps/api/.env.example`, `.env.example`, `apps/api-deploy/.env.example`:
- Document `EMAIL_PROVIDER=pulseem` as an option
- Add `PULSEEM_EMAIL_FROM_EMAIL`, `PULSEEM_EMAIL_FROM_NAME` examples

## Observability

New `[post-sale email]` log namespace:
- `[post-sale email] skipped: no customer email`
- `[post-sale email] skipped: emailOnPurchase disabled`
- `[post-sale email] minted handoff token`
- `[post-sale email] sent` / `[post-sale email] provider error` / `[post-sale email] failed silently`

Mirrors the `[wc post-sale]` / `[cards post-sale]` namespaces for SMS, so
an operator can grep both channels with similar patterns.

## Security (Rule 13)

- **No new attack surface.** Email is server-built from validated env +
  trusted DB rows; recipient comes from the customer row (not from URL or
  user input). Same chain of custody as SMS.
- **Token isolation.** Independent token per channel means an SMS leak
  doesn't compromise the email link and vice versa.
- **Transactional classification.** Same Israeli Comm. Act amend. 40
  carve-out the SMS path relies on. Bypasses `marketingConsentAt` and
  quiet hours; honors only the new `emailOnPurchase` operator switch.
- **No PII in logs.** Email address is masked the same way phone numbers
  are masked in the SMS provider.

## Settings audit (Rule 15)

| New control | Surface | Default | Why exposed |
|---|---|---|---|
| `emailOnPurchase` | admin Settings → SMS+Email | `true` | Operator master switch (matches `smsOnPurchase` shape) |

Hardcoded for v1 (could become admin-editable later):
- Subject line
- HTML body template

Reasoning: matches how SMS body is hardcoded today. If Yanay later asks
to edit the email subject/body from admin, add `email_on_purchase_subject`
+ `email_on_purchase_body_html` to the settings table the same way
`checkout_thankyou_*` are surfaced.

## Cost note (Rule 8)

Pulseem email is bundled with Yanai's existing SMS plan. Need to confirm
transactional email pricing per send vs the bundled allotment — flagged
as a follow-up but not a blocker since the user already approved.

## Out of scope

- Admin-editable subject/body templates (v2)
- WhatsApp Business as a third channel
- A/B testing of subject lines
- Email open-rate analytics
- Per-customer channel preference enforcement (today: send to both when both available)
