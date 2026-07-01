-- Round operational settings (2026-07-01). Singleton config table backing the
-- runtime knobs the rounds purchase/cancel/waitlist flow reads (super-brief
-- §15): hold TTL, cancellation window, waitlist claim window. Pure additive —
-- no changes to existing tables, no data migration.
--
-- NOTE: drizzle-kit generated a full-schema catch-up here because the stored
-- snapshot had drifted from the hand-written 0014–0017 migrations. Those
-- migrations already build every table on a real DB, so this file is reduced to
-- the one new table it actually introduces. The regenerated 0018 snapshot
-- re-syncs drizzle's diff state going forward.
--
-- Idempotent (lesson from the 0015 incident): CREATE TABLE IF NOT EXISTS + the
-- singleton seed gated by ON CONFLICT. Safe to re-apply.

CREATE TABLE IF NOT EXISTS "round_settings" (
  -- Singleton: id = 1 always, CHECK-enforced. Matches the other settings tables.
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  -- Minutes a seat is held before payment (super-brief §3). Default 15.
  "hold_ttl_minutes" smallint NOT NULL DEFAULT 15,
  -- Hours before start that a paid booking may still be cancelled for a refund
  -- (super-brief §6.2). After this, swap only. Default 24.
  "cancellation_window_hours" smallint NOT NULL DEFAULT 24,
  -- Minutes a waitlisted customer has to claim a freed seat (super-brief §8).
  -- Default 60.
  "claim_window_minutes" smallint NOT NULL DEFAULT 60,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "round_settings_singleton" CHECK ("id" = 1),
  CONSTRAINT "round_settings_hold_ttl_positive" CHECK ("hold_ttl_minutes" > 0),
  CONSTRAINT "round_settings_cancel_window_nonneg" CHECK ("cancellation_window_hours" >= 0),
  CONSTRAINT "round_settings_claim_window_positive" CHECK ("claim_window_minutes" > 0)
);
--> statement-breakpoint
-- Seed the singleton row. ON CONFLICT makes re-apply a no-op.
INSERT INTO "round_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
