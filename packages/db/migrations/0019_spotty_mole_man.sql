-- Barcode versioning on bookings (2026-07-01). Signed into the round-booking
-- barcode token so a swap can bump the version + re-mint, invalidating any old
-- screenshotted QR from before the swap. Additive, defaults to 1. Idempotent.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "barcode_version" smallint DEFAULT 1 NOT NULL;
