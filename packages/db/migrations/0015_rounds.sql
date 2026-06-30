-- Rounds entry system (2026-07-01). Foundational tables for the new
-- rounds-based ticket flow described in memesh-rounds-super-brief.md §1.2.
-- Pure additive — no changes to existing tables, no data migration.
--
-- Tables:
--   1. rounds            — recurring template (e.g., "afternoon 16:00-18:00").
--   2. round_instances   — round materialized for a specific date; carries
--                          effective capacity (overridable for holidays/events).
--   3. bookings          — customer-to-round assignments. State machine: held →
--                          confirmed → used; or held → expired; or confirmed →
--                          cancelled. Carries the per-booking barcode + hold TTL.
--   4. waitlist_entries  — FIFO list per round_instance for full rounds.
--
-- Enums (all new — no overlap with existing types):
--   - ticket_type       : child_under_walking | child_over_walking
--   - booking_source    : paid | punchcard | gift | manual
--   - booking_status    : held | confirmed | used | cancelled | expired
--   - waitlist_status   : waiting | notified | claimed | expired | cancelled
--
-- IDEMPOTENCY (2026-07-01 hotfix):
-- The first production apply of this migration failed mid-way and left the
-- enum types behind (PostgreSQL CREATE TYPE doesn't roll back when a later
-- statement in the same migration fails). Re-running then errored on
-- `type "ticket_type" already exists`. This rewrite makes every statement
-- safe to re-apply:
--   - CREATE TYPE is wrapped in DO blocks that swallow duplicate_object
--   - CREATE TABLE uses IF NOT EXISTS
--   - CREATE INDEX uses IF NOT EXISTS
--   - UNIQUE / CHECK / FOREIGN KEY constraints are declared inline in the
--     CREATE TABLE so they only fire when the table is newly created
-- CHECK constraints are belt-and-suspenders for application-layer validation.

DO $$ BEGIN
  CREATE TYPE "ticket_type" AS ENUM ('child_under_walking', 'child_over_walking');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "booking_source" AS ENUM ('paid', 'punchcard', 'gift', 'manual');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "booking_status" AS ENUM ('held', 'confirmed', 'used', 'cancelled', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "waitlist_status" AS ENUM ('waiting', 'notified', 'claimed', 'expired', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "label" varchar(64) NOT NULL,
  "display_name" varchar(128) NOT NULL,
  "start_time" time NOT NULL,
  "end_time" time NOT NULL,
  -- Bitmask: bit 0 = Sunday … bit 6 = Saturday. 127 = all 7 days (default).
  "days_active" smallint NOT NULL DEFAULT 127,
  "default_capacity" integer NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rounds_capacity_nonneg" CHECK ("default_capacity" >= 0),
  CONSTRAINT "rounds_days_active_range" CHECK ("days_active" >= 0 AND "days_active" <= 127),
  CONSTRAINT "rounds_time_order" CHECK ("start_time" < "end_time")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "round_instances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "round_id" uuid NOT NULL REFERENCES "rounds"("id"),
  "date" date NOT NULL,
  -- Mirrors rounds.default_capacity at creation time; admin can override
  -- per date (e.g., reduce for a private event, raise for a special day).
  "capacity" integer NOT NULL,
  -- Manual closure (private event, holiday). Separate from is_active on
  -- rounds — is_active disables the recurring template; is_closed kills a
  -- single date.
  "is_closed" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "round_instances_capacity_nonneg" CHECK ("capacity" >= 0),
  CONSTRAINT "round_instances_round_date_unique" UNIQUE ("round_id", "date")
);
--> statement-breakpoint
-- Hot path: dashboard "today's rounds" lookup, customer round selector
-- ("show me availability for date X"). Indexed up-front; even a few months
-- of round_instances will outgrow a sequential scan.
CREATE INDEX IF NOT EXISTS "round_instances_date_idx" ON "round_instances" ("date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "round_instance_id" uuid NOT NULL REFERENCES "round_instances"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "ticket_type" "ticket_type" NOT NULL,
  -- 0 or 1 per Yanay's rule (settings-driven additional_companion_max_per_child).
  -- The DB allows higher values for future flexibility; the API enforces the
  -- per-child limit at booking time.
  "additional_companions" smallint NOT NULL DEFAULT 0,
  "source" "booking_source" NOT NULL,
  "status" "booking_status" NOT NULL,
  -- Set only after status transitions to 'confirmed' (HMAC-signed payload).
  -- UNIQUE so a scan at the door always resolves to exactly one booking.
  "barcode_token" varchar(128) UNIQUE,
  -- Set only when status = 'held'. NULL for confirmed/used/cancelled/expired.
  -- Partial index below covers the cleanup-job hot path.
  "hold_expires_at" timestamp with time zone,
  -- VARCHAR not BIGINT — matches punch_cards.wc_order_id shape so reports
  -- can join on a single type. WC integers fit, but the column also accepts
  -- non-numeric identifiers from future payment paths if needed.
  "wc_order_id" varchar(64),
  -- Set when source = 'punchcard'. References the card the booking was
  -- paid from. Allows refunding the punch on cancellation.
  "punch_card_id" uuid REFERENCES "punch_cards"("id"),
  -- Set when source = 'gift'. Snapshot of recipient details at order time.
  -- Shape: { firstName, lastName, phone, email }. Stored as JSONB so it's
  -- queryable for support without joining anywhere.
  "gift_recipient" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "confirmed_at" timestamp with time zone,
  "used_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bookings_companions_nonneg" CHECK ("additional_companions" >= 0)
);
--> statement-breakpoint
-- Hot path: dashboard availability calculation (COUNT per round_instance
-- filtered by status). Composite index lets it index-only-scan.
CREATE INDEX IF NOT EXISTS "bookings_round_instance_status_idx" ON "bookings" ("round_instance_id", "status");
--> statement-breakpoint
-- Customer personal area: "my upcoming bookings" — by customer + active status.
CREATE INDEX IF NOT EXISTS "bookings_customer_status_idx" ON "bookings" ("customer_id", "status");
--> statement-breakpoint
-- Cleanup job (runs every minute): expire held rows past their TTL. Partial
-- index keeps it tiny — only the rows that are actually candidates for expiry.
CREATE INDEX IF NOT EXISTS "bookings_hold_expires_idx" ON "bookings" ("hold_expires_at") WHERE "status" = 'held';
--> statement-breakpoint
-- Webhook idempotency: mint endpoint looks up existing booking by wc_order_id
-- before creating a new one. Same pattern as punch_cards.wc_order_id_idx.
CREATE INDEX IF NOT EXISTS "bookings_wc_order_idx" ON "bookings" ("wc_order_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "waitlist_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "round_instance_id" uuid NOT NULL REFERENCES "round_instances"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "requested_type" "ticket_type" NOT NULL,
  "requested_companions" smallint NOT NULL DEFAULT 0,
  "status" "waitlist_status" NOT NULL DEFAULT 'waiting',
  "notified_at" timestamp with time zone,
  "claim_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "waitlist_companions_nonneg" CHECK ("requested_companions" >= 0)
);
--> statement-breakpoint
-- FIFO lookup: "next waiting entry for round X" — composite covers the
-- ORDER BY created_at ASC LIMIT 1 query in on_slot_freed().
CREATE INDEX IF NOT EXISTS "waitlist_round_status_created_idx" ON "waitlist_entries" ("round_instance_id", "status", "created_at");
