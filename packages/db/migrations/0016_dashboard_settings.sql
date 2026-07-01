-- Admin dashboard settings (2026-07-01). Adds the singleton config table
-- backing §15.3 of the rounds super-brief: refresh interval, revenue
-- privacy toggle, week-ahead toggle, capacity color thresholds, widget
-- order. Pure additive — no changes to existing tables, no data migration.
--
-- Idempotent throughout (lesson from the 0015 incident): CREATE TABLE
-- IF NOT EXISTS, plus the singleton-row INSERT is gated by a DO block
-- that swallows a duplicate-key conflict. Safe to re-apply against a DB
-- that already has it.

CREATE TABLE IF NOT EXISTS "dashboard_settings" (
  -- Singleton pattern: id = 1 always. CHECK guarantees no second row can
  -- be inserted. Same pattern other singleton settings tables use.
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  -- Auto-refresh cadence in seconds. 30s default matches the polling
  -- interval the SPA uses by default.
  "refresh_interval_seconds" smallint NOT NULL DEFAULT 30,
  -- When false, the API strips revenueIls / revenueDeltaPct from the
  -- /admin/dashboard/live response. Lets ops hide revenue from
  -- shoulder-surfers or screenshare without yanking the whole dashboard.
  "show_revenue" boolean NOT NULL DEFAULT true,
  -- When false, the SPA hides the 7-day forward grid.
  "show_week_ahead" boolean NOT NULL DEFAULT true,
  -- Capacity % thresholds for the round status color: < warning = green,
  -- warning..danger = amber, >= danger = red. Constrained to 0..100.
  "capacity_warning_pct" smallint NOT NULL DEFAULT 70,
  "capacity_danger_pct" smallint NOT NULL DEFAULT 90,
  -- JSON array of widget keys in display order. Removing a key hides the
  -- widget; the SPA renders only the keys present here. Default order
  -- matches the plan's "single column stack" recommendation.
  "widgets_order" jsonb NOT NULL DEFAULT '["rounds_today","stats_today","alerts","waitlist","week_ahead"]'::jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dashboard_settings_singleton" CHECK ("id" = 1),
  CONSTRAINT "dashboard_settings_warning_pct_range" CHECK ("capacity_warning_pct" BETWEEN 0 AND 100),
  CONSTRAINT "dashboard_settings_danger_pct_range" CHECK ("capacity_danger_pct" BETWEEN 0 AND 100),
  CONSTRAINT "dashboard_settings_warning_le_danger" CHECK ("capacity_warning_pct" <= "capacity_danger_pct"),
  CONSTRAINT "dashboard_settings_refresh_positive" CHECK ("refresh_interval_seconds" > 0)
);
--> statement-breakpoint
-- Seed the singleton row. The ON CONFLICT clause makes this idempotent
-- on re-apply: if the row already exists (because a previous apply
-- succeeded the INSERT before failing elsewhere), the seed is a no-op.
INSERT INTO "dashboard_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
