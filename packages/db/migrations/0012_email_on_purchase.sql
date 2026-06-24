-- Post-purchase email cutover (2026-06-23). Mirrors the sms_on_purchase
-- master switch so the operator can disable the post-purchase email
-- channel from the admin Settings page without touching the SMS toggle.
-- See _plans/2026-06-23-post-purchase-email.md.
ALTER TABLE "card_settings" ADD COLUMN "email_on_purchase" boolean NOT NULL DEFAULT true;
