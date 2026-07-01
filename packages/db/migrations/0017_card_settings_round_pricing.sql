-- Round entry pricing (2026-07-02). Adds three price columns to card_settings
-- so the admin dashboard can compute real revenue for round-based bookings
-- (step 3b of admin-rounds-dashboard). Prices match the real WC product
-- values already in the store as of PR #23:
--
--   product 1002 "כרטיס כניסה לתינוק/ת + מבוגר/ת מלווה" — ₪45
--   product 1001 "כרטיס כניסה לילד/ה יחיד/ה + מבוגר/ת מלווה" — ₪55
--   product 1003 "כרטיס כניסה למלווה שני/ה" — ₪12
--
-- Pure additive. Idempotent — ADD COLUMN IF NOT EXISTS has been supported
-- since PG 9.6 and it's what the drizzle-kit-generated ALTER TABLE for the
-- gift_cards migration would have used had it existed then.

ALTER TABLE "card_settings"
  ADD COLUMN IF NOT EXISTS "round_child_baby_price_ils" integer NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS "round_child_over_walking_price_ils" integer NOT NULL DEFAULT 55,
  ADD COLUMN IF NOT EXISTS "round_additional_companion_price_ils" integer NOT NULL DEFAULT 12;
--> statement-breakpoint

-- CHECK constraints: prices must be non-negative. Belt-and-suspenders for
-- the validation the app-layer settings helper enforces (0..1000). Wrapped
-- in DO blocks so re-apply is safe.

DO $$ BEGIN
  ALTER TABLE "card_settings"
    ADD CONSTRAINT "card_settings_round_baby_price_nonneg"
    CHECK ("round_child_baby_price_ils" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "card_settings"
    ADD CONSTRAINT "card_settings_round_over_price_nonneg"
    CHECK ("round_child_over_walking_price_ils" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "card_settings"
    ADD CONSTRAINT "card_settings_round_companion_price_nonneg"
    CHECK ("round_additional_companion_price_ils" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
