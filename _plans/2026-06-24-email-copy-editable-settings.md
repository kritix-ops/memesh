# Post-purchase email — admin-editable copy + Memesh logo branding

**Date:** 2026-06-24
**Author:** Claude (Opus 4.7) for Yoav (Flexelent)
**Builds on:** `_plans/2026-06-23-post-purchase-email.md` (the post-purchase
email cutover shipped 2026-06-23 as PR #15 / commit `d4569fc`).

## Goal

Two related polish items on top of the already-live post-purchase email:

1. **Admin-editable copy** — five text strings in the email body lift out
   of `apps/api/src/lib/post-purchase-email.ts` into `card_settings`
   columns, edited via the admin Settings page. Yanai can tweak the
   wording without an engineer + a deploy. Mirrors the existing
   `checkout_thankyou_*` pattern.
2. **Memesh logo header** — replace the text-only "Memesh" header tag in
   the email with the actual brand logo image, anchored to the main
   site so clicking it goes to memesh.co.il.

Out of scope: making the logo, colors, or visual layout admin-editable.
Per rule 16 + rule 5, branding visuals stay in code so they don't drift
toward a generic-AI-template look as operators tinker.

## Editable fields

Five new `text NOT NULL` columns on `card_settings`, mirroring the
`checkout_thankyou_*` naming:

| Column | Hebrew default | Where it appears | Placeholder support |
|---|---|---|---|
| `email_on_purchase_subject` | `הכרטיסייה שלך ב-Memesh מוכנה` | Subject line | `{{firstName}}` |
| `email_on_purchase_headline` | `שלום {{firstName}}, הכרטיסייה שלך מוכנה!` | `<h1>` of the email | `{{firstName}}` |
| `email_on_purchase_intro` | `תודה שרכשת אצלנו — אנחנו מחכים לראותך.` | Paragraph under the card-detail line | `{{firstName}}` |
| `email_on_purchase_cta_text` | `לצפייה באזור האישי` | Button label | none |
| `email_on_purchase_footer_note` | `הודעה זו נשלחה לאחר רכישה ב-Memesh. אין צורך להשיב אליה.` | Bottom-of-email note | none |

Length limits + placeholder validation use the same conventions as the
existing `checkout_thankyou_*` validators in `packages/db/src/card-settings.ts`.

### Why these five, not more

| Stays in code (NOT editable) | Why |
|---|---|
| Logo image + size | Branding visual, rule 5 |
| Cream/salmon palette | Branding visual |
| Card-detail line ("12 כניסות, תוקף עד...") | Data-driven from the purchase, not editable copy |
| "If the button doesn't open, copy the link" fallback paragraph | Accessibility safety net; operators shouldn't be able to remove it |
| Multi-card subject branch (`N כרטיסיות חדשות`) | Currently derived from the single subject template; if/when Yanai wants per-branch subjects we'll add a second column |

### Single-vs-multi-card handling

The current code uses two different subject strings for `cards.length === 1`
vs `>= 2`. For v1 of editable copy, there's ONE editable subject. Operator's
responsibility to write something that reads naturally for both cases — and
the default `הכרטיסייה שלך ב-Memesh מוכנה` works as a single string for
both (singular form covers the common case; multi-card is rare enough that
"the card is ready" is still understandable). If multi-card becomes common
and the singular reads wrong, we add `email_on_purchase_subject_multi`
later — separate column, no migration churn.

## Memesh logo

- **Asset**: `apps/customer/public/og-image.png` (1201×421 transparent PNG,
  16KB). Same file as `logo/memeshnoback.png` at the repo root.
- **URL in email**: `${CUSTOMER_BASE_URL}/og-image.png` — server-built
  from env, https-enforced in production by the existing `config.ts`
  superRefine.
- **Rendered size in email**: width 200px, height auto via aspect
  ratio (~70px tall). Width attribute set on the `<img>` for email-client
  compatibility (Outlook 2016 ignores CSS `width`).
- **Wrapping link**: `<a href="https://memesh.co.il">` — clicking the
  logo opens the main marketing site, the conventional behavior.
- **Alt text**: `alt="Memesh"`. Image-blocking clients (the
  many Gmail/Outlook setups that block remote images by default) render
  the word "Memesh" inline.
- **Email-safe attributes**: `display:block` (kills bottom-of-image gap
  in Outlook), `border:0` (Outlook 2007 inherited blue link border),
  `outline:none` (focus rings on linked images in some webmail clients).

Replaces the current `<div ...>Memesh</div>` text tag at the top of the
email body. Keeps the visual hierarchy (logo → headline → body → CTA →
footer) intact.

## Implementation steps

### 1. Migration `0013_email_on_purchase_copy.sql`

```sql
ALTER TABLE "card_settings"
  ADD COLUMN "email_on_purchase_subject" text NOT NULL DEFAULT 'הכרטיסייה שלך ב-Memesh מוכנה',
  ADD COLUMN "email_on_purchase_headline" text NOT NULL DEFAULT 'שלום {{firstName}}, הכרטיסייה שלך מוכנה!',
  ADD COLUMN "email_on_purchase_intro" text NOT NULL DEFAULT 'תודה שרכשת אצלנו — אנחנו מחכים לראותך.',
  ADD COLUMN "email_on_purchase_cta_text" text NOT NULL DEFAULT 'לצפייה באזור האישי',
  ADD COLUMN "email_on_purchase_footer_note" text NOT NULL DEFAULT 'הודעה זו נשלחה לאחר רכישה ב-Memesh. אין צורך להשיב אליה.';
```

Idempotent SQL: every column has a default, so existing rows backfill
on the ALTER. No follow-up `UPDATE` needed.

### 2. Drizzle schema (`packages/db/src/schema/card-settings.ts`)

Five new `text(...).notNull().default(...)` columns alongside the
existing `email_on_purchase` boolean. Keep them grouped under the
"SMS + email" section with a comment explaining the editable-copy
intent.

### 3. Validators + audit log labels (`packages/db/src/card-settings.ts`)

- Extend `CARD_SETTINGS_LIMITS` with min/max lengths for each new field.
  Use the same limits as `checkout_thankyou_*` siblings (title 1-120,
  body 1-500, button 1-40).
- Extend `UpdateCardSettingsInput` with the five new optional strings.
- Extend `CardSettingsValidationError` union with the new error codes
  (`email_on_purchase_subject_length` etc., plus
  `email_on_purchase_*_unknown_placeholder` for the headline+intro
  pair that supports placeholders).
- Reuse `validateHandoffThankyouTemplate` from
  `handoff-thankyou.ts` — it already gates `{{firstName}}` as the only
  allowed placeholder, exactly what we want.
- Add Hebrew labels to `FIELD_LABELS` so the staff_actions audit log
  reads cleanly (`email_on_purchase_subject: 'נושא אימייל'`, etc.).
- Wire each field into the `updateCardSettings` assign block.

### 4. Body builder refactor (`apps/api/src/lib/post-purchase-email.ts`)

`buildPostPurchaseEmailBody`'s input gains a `copy` block:

```ts
export interface BuildPostPurchaseEmailBodyInput {
  firstName: string;
  cards: ReadonlyArray<PostSaleSmsCard>;
  link: string;
  copy: {
    subject: string;
    headline: string;
    intro: string;
    ctaText: string;
    footerNote: string;
  };
  logoUrl: string;
}
```

Subject + headline + intro run through `renderHandoffThankyou` (reused;
generic-enough name aside) so `{{firstName}}` substitutes with the
"לקוח/ה" fallback when blank. Substituted strings are then
HTML-escaped before embedding in the HTML body. The plain-text body
uses the un-escaped substituted strings.

`firePostPurchaseEmail` reads `settings.emailOnPurchase*` fields it
already loads via `getCardSettings`, constructs the `copy` block, and
passes `logoUrl = ${env.CUSTOMER_BASE_URL}/og-image.png`.

The logo `<img>` replaces the current `<div>Memesh</div>` tag at the top
of the HTML.

### 5. Admin UI (`apps/admin/src/admin/settings/Settings.tsx`)

New section `SectionShell title="תוכן אימייל לאחר רכישה"`, sibling of
the existing thank-you section. Five `TextField`/`TextArea` controls,
Hebrew labels, hint text explaining `{{firstName}}` is the only allowed
placeholder.

`CardSettings` type + `CardSettingsPatch` type extended in
`apps/admin/src/lib/api/card-settings.ts`.

### 6. API Zod schema (`apps/api/src/routes/card-settings.ts`)

Add the five fields as `z.string().min(L.*.min).max(L.*.max).optional()`.

### 7. Tests

- `packages/db/src/card-settings.test.ts` (if present, or extend the
  existing accounts.test.ts pattern): validation cases — too short,
  too long, unknown placeholder.
- `apps/api/src/lib/post-purchase-email.test.ts`: extend
  `buildPostPurchaseEmailBody` tests to assert the copy fields render
  + escape + substitute. Add a test asserting the logo `<img>` is
  present with `src="${CUSTOMER_BASE_URL}/og-image.png"`, `alt="Memesh"`,
  `width="200"`.
- Existing helper tests pass `copy` + `logoUrl` through the new shape.

### 8. env.example notes

No new env vars. Document in the email comment block that the logo URL
is derived from `CUSTOMER_BASE_URL`.

### 9. Migration journal

Add entry `idx 13` to `packages/db/migrations/meta/_journal.json`.

## Security (Rule 13)

- **Placeholder injection**: `{{firstName}}` is the only allowed
  placeholder; renderer escapes the substituted name. Existing
  `validateHandoffThankyouTemplate` enforces this at admin-save time
  AND the renderer escapes at render time — belt-and-suspenders.
- **HTML injection via admin copy**: operator-supplied subject /
  headline / intro / cta / footer values get HTML-escaped before being
  embedded in the HTML body. Even an admin who tries to inject
  `<script>` would see `&lt;script&gt;` in the recipient's inbox.
  Per rule 13: validate at the boundary AND escape at output.
- **No new attack surface**: the admin Settings PATCH route already
  requires admin/manager role and audits every change. The new fields
  ride that.

## Observability (Rule 14)

No new log lines. The existing `[post-sale email]` namespace covers
mint + send + error. The Settings PATCH writes a `staff_actions` row
with the diff (existing behavior), so we can grep for "נושא אימייל
שונה" type lines in the audit log.

## Out of scope

- Per-card-count subject templates (e.g. different subject for
  multi-card). Add later if Yanay reports it reads wrong.
- Per-locale copy (different copy for English customers). Memesh is
  Israeli-customer only today.
- A/B testing of subject lines (would require a different
  architecture — token-bucket experiment, analytics, etc.).
- Admin-editable logo / colors / layout (rule 5 + rule 16: branding
  visuals stay in code).
- Inline-image embedding (CID attachment) vs remote URL. We use remote
  URL because Pulseem's transactional API doesn't expose an attachment
  field for our send path, and modern email clients handle remote images
  fine when the sender has good DNS auth (which we now do).
