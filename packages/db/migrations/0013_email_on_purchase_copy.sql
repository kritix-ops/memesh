-- Admin-editable post-purchase email copy (2026-06-24). Five text strings
-- lift from hardcoded constants in apps/api/src/lib/post-purchase-email.ts
-- into card_settings so Yanai can tweak wording from admin Settings without
-- an engineering deploy. Mirrors the existing checkout_thankyou_* pattern.
-- Defaults below match the current hardcoded copy so the cutover is a no-op.
-- See _plans/2026-06-24-email-copy-editable-settings.md.
ALTER TABLE "card_settings"
  ADD COLUMN "email_on_purchase_subject" text NOT NULL DEFAULT 'הכרטיסייה שלך ב-Memesh מוכנה',
  ADD COLUMN "email_on_purchase_headline" text NOT NULL DEFAULT 'שלום {{firstName}}, הכרטיסייה שלך מוכנה!',
  ADD COLUMN "email_on_purchase_intro" text NOT NULL DEFAULT 'תודה שרכשת אצלנו — אנחנו מחכים לראותך.',
  ADD COLUMN "email_on_purchase_cta_text" text NOT NULL DEFAULT 'לצפייה באזור האישי',
  ADD COLUMN "email_on_purchase_footer_note" text NOT NULL DEFAULT 'הודעה זו נשלחה לאחר רכישה ב-Memesh. אין צורך להשיב אליה.';
