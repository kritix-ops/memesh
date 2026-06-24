-- Gift card flow (2026-06-24). Adds three pieces:
--   1. gift_pending_claims — pending rows for gift orders where the recipient
--      isn't yet a Memesh customer. Holds buyer + recipient details and a
--      single-use claim token until the recipient verifies their phone.
--   2. punch_cards.{is_gift, gift_buyer_*, gift_claimed_at} — gift provenance
--      on every card minted from a gift order, regardless of which branch
--      (direct-mint to existing customer, or claim flow) produced the card.
--   3. card_settings — operator kill-switch, claim TTL, buyer-notify toggle,
--      and editable Hebrew copy for the three gift email variants
--      (recipient, buyer confirmation, buyer claim notification).
--
-- See _plans/2026-06-24-gift-card-checkout.md for the full design.
CREATE TABLE "gift_pending_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wc_order_id" varchar(64) NOT NULL,
  "wc_sku" varchar(64) NOT NULL,
  "buyer_first_name" text NOT NULL,
  "buyer_last_name" text NOT NULL,
  "buyer_email" text NOT NULL,
  "buyer_phone" varchar(32) NOT NULL,
  "recipient_first_name" text NOT NULL,
  "recipient_last_name" text NOT NULL,
  "recipient_email" text NOT NULL,
  "recipient_phone" varchar(32) NOT NULL,
  "claim_token_hash" varchar(64) NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "claimed_at" timestamp with time zone,
  "minted_card_id" uuid REFERENCES "punch_cards"("id"),
  "expired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gift_pending_claims_wc_order_id_idx" ON "gift_pending_claims" ("wc_order_id");
--> statement-breakpoint
CREATE INDEX "gift_pending_claims_recipient_phone_idx" ON "gift_pending_claims" ("recipient_phone");
--> statement-breakpoint
CREATE INDEX "gift_pending_claims_expires_at_idx" ON "gift_pending_claims" ("expires_at");
--> statement-breakpoint
ALTER TABLE "punch_cards"
  ADD COLUMN "is_gift" boolean NOT NULL DEFAULT false,
  ADD COLUMN "gift_buyer_first_name" text,
  ADD COLUMN "gift_buyer_last_name" text,
  ADD COLUMN "gift_buyer_phone" varchar(32),
  ADD COLUMN "gift_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "card_settings"
  ADD COLUMN "gift_cards_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "gift_claim_ttl_days" integer NOT NULL DEFAULT 365,
  ADD COLUMN "gift_buyer_notify_on_claim" boolean NOT NULL DEFAULT true,
  ADD COLUMN "gift_recipient_email_subject" text NOT NULL DEFAULT '{{buyerFirstName}} שלח/ה לך כרטיסיית מתנה!',
  ADD COLUMN "gift_recipient_email_headline" text NOT NULL DEFAULT 'קיבלת מתנה!',
  ADD COLUMN "gift_recipient_email_intro" text NOT NULL DEFAULT '{{buyerFirstName}} בחר/ה להעניק לך כרטיסיית מתנה ב-Memesh.',
  ADD COLUMN "gift_recipient_email_magic_cta_text" text NOT NULL DEFAULT 'פתחו את הכרטיסייה',
  ADD COLUMN "gift_recipient_email_claim_cta_text" text NOT NULL DEFAULT 'קבלו את המתנה',
  ADD COLUMN "gift_recipient_email_footer_note" text NOT NULL DEFAULT 'יש לכם שאלות? נשמח לעזור — פנו אלינו בכל עת.',
  ADD COLUMN "gift_buyer_email_subject" text NOT NULL DEFAULT 'הזמנת כרטיסיית מתנה ל-{{recipientFirstName}}',
  ADD COLUMN "gift_buyer_email_headline" text NOT NULL DEFAULT 'תודה על המתנה!',
  ADD COLUMN "gift_buyer_email_intro" text NOT NULL DEFAULT 'שלחנו ל-{{recipientFirstName}} מייל עם הכרטיסייה.',
  ADD COLUMN "gift_buyer_email_footer_note" text NOT NULL DEFAULT 'נעדכן אותך כשהמתנה תיפתח על ידי הנמען/ת.',
  ADD COLUMN "gift_buyer_claim_email_subject" text NOT NULL DEFAULT '{{recipientFirstName}} פתח/ה את המתנה שלך!',
  ADD COLUMN "gift_buyer_claim_email_headline" text NOT NULL DEFAULT 'המתנה נפתחה',
  ADD COLUMN "gift_buyer_claim_email_intro" text NOT NULL DEFAULT '{{recipientFirstName}} פתח/ה את הכרטיסייה שהענקת. תודה שבחרת ב-Memesh.',
  ADD COLUMN "gift_buyer_claim_email_footer_note" text NOT NULL DEFAULT 'הודעה זו נשלחה לאחר רכישה ב-Memesh. אין צורך להשיב אליה.';
