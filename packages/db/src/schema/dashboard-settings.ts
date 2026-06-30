import { boolean, jsonb, pgTable, smallint, timestamp } from 'drizzle-orm/pg-core';

// Singleton config table backing §15.3 of the rounds super-brief. Exactly
// one row (id = 1, CHECK-enforced in the migration) holds the admin
// dashboard's runtime knobs: refresh cadence, revenue privacy toggle,
// week-ahead toggle, capacity color thresholds, and the widget order
// JSON the SPA reads to render zones.
//
// The CHECK constraints + singleton enforcement live in 0016_dashboard_settings.sql.
// Application-layer validation (range checks, widget key whitelist) lives
// in dashboard-settings.ts alongside the helpers.
export const dashboardSettings = pgTable('dashboard_settings', {
  id: smallint('id').primaryKey().notNull().default(1),
  refreshIntervalSeconds: smallint('refresh_interval_seconds').notNull().default(30),
  // When false, /admin/dashboard/live response omits revenueIls +
  // revenueDeltaPct. Lets ops hide revenue from shoulder-surfers or
  // screenshares without disabling the whole dashboard.
  showRevenue: boolean('show_revenue').notNull().default(true),
  showWeekAhead: boolean('show_week_ahead').notNull().default(true),
  capacityWarningPct: smallint('capacity_warning_pct').notNull().default(70),
  capacityDangerPct: smallint('capacity_danger_pct').notNull().default(90),
  // JSON array of widget keys in display order. Removing a key hides the
  // widget; the SPA renders only the keys present here.
  widgetsOrder: jsonb('widgets_order')
    .notNull()
    .default([
      'rounds_today',
      'stats_today',
      'alerts',
      'waitlist',
      'week_ahead',
    ]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DashboardSettingsRow = typeof dashboardSettings.$inferSelect;
export type NewDashboardSettings = typeof dashboardSettings.$inferInsert;
