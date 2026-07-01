// Tests for the dashboard_settings singleton: read, partial update,
// validation rules, and the pure privacy-gate helper. The migration
// itself is exercised by freshDb() applying 0016_dashboard_settings.sql.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  applyRevenuePrivacyGate,
  getDashboardSettings,
  updateDashboardSettings,
  validateDashboardSettingsPatch,
} from './dashboard-settings';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

// ---------------------------------------------------------------------------
// getDashboardSettings — returns seeded singleton with defaults
// ---------------------------------------------------------------------------

test('getDashboardSettings returns the seeded singleton with defaults', async () => {
  const db = await freshDb();
  const settings = await getDashboardSettings(db);
  assert.equal(settings.id, 1);
  assert.equal(settings.refreshIntervalSeconds, 30);
  assert.equal(settings.showRevenue, true);
  assert.equal(settings.showWeekAhead, true);
  assert.equal(settings.capacityWarningPct, 70);
  assert.equal(settings.capacityDangerPct, 90);
  assert.deepEqual(settings.widgetsOrder, [
    'rounds_today',
    'stats_today',
    'alerts',
    'waitlist',
    'week_ahead',
  ]);
});

test('getDashboardSettings is idempotent: second call returns the same row', async () => {
  const db = await freshDb();
  const a = await getDashboardSettings(db);
  const b = await getDashboardSettings(db);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// updateDashboardSettings — happy path + diff
// ---------------------------------------------------------------------------

test('updateDashboardSettings persists changed fields and returns diff', async () => {
  const db = await freshDb();
  const result = await updateDashboardSettings(db, {
    refreshIntervalSeconds: 60,
    showRevenue: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.refreshIntervalSeconds, 60);
  assert.equal(result.row.showRevenue, false);
  assert.deepEqual(result.diff.refreshIntervalSeconds, [30, 60]);
  assert.deepEqual(result.diff.showRevenue, [true, false]);
});

test('updateDashboardSettings returns noChanges on a no-op patch', async () => {
  const db = await freshDb();
  const result = await updateDashboardSettings(db, {
    refreshIntervalSeconds: 30, // already the default
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal('noChanges' in result ? result.noChanges : false, true);
  assert.deepEqual(result.diff, {});
});

test('updateDashboardSettings updates widgetsOrder when the array changes', async () => {
  const db = await freshDb();
  const result = await updateDashboardSettings(db, {
    widgetsOrder: ['stats_today', 'rounds_today', 'alerts', 'waitlist', 'week_ahead'],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.row.widgetsOrder, [
    'stats_today',
    'rounds_today',
    'alerts',
    'waitlist',
    'week_ahead',
  ]);
});

// ---------------------------------------------------------------------------
// updateDashboardSettings — validation
// ---------------------------------------------------------------------------

test('updateDashboardSettings rejects refresh interval below 5s', async () => {
  const db = await freshDb();
  const result = await updateDashboardSettings(db, { refreshIntervalSeconds: 2 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'refresh_interval_out_of_range');
});

test('updateDashboardSettings rejects refresh interval above 3600s', async () => {
  const db = await freshDb();
  const result = await updateDashboardSettings(db, { refreshIntervalSeconds: 4000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'refresh_interval_out_of_range');
});

test('updateDashboardSettings rejects capacity percentages outside 0..100', async () => {
  const db = await freshDb();
  const a = await updateDashboardSettings(db, { capacityWarningPct: 150 });
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.error.code, 'capacity_warning_out_of_range');

  const b = await updateDashboardSettings(db, { capacityDangerPct: -1 });
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.error.code, 'capacity_danger_out_of_range');
});

test('updateDashboardSettings rejects warning > danger', async () => {
  const db = await freshDb();
  // Try to set warning above danger: warning=95, danger=defaults 90
  const result = await updateDashboardSettings(db, { capacityWarningPct: 95 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'capacity_warning_above_danger');
});

test('updateDashboardSettings accepts simultaneous warning + danger when warning <= danger', async () => {
  const db = await freshDb();
  // Set both at once so the warning >= old-danger but new-warning <= new-danger
  const result = await updateDashboardSettings(db, {
    capacityWarningPct: 80,
    capacityDangerPct: 95,
  });
  assert.equal(result.ok, true);
});

test('updateDashboardSettings rejects unknown widget key', async () => {
  const db = await freshDb();
  const result = await updateDashboardSettings(db, {
    widgetsOrder: ['rounds_today', 'made_up_widget'],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'widgets_order_unknown_key');
  if (result.error.code === 'widgets_order_unknown_key') {
    assert.equal(result.error.key, 'made_up_widget');
  }
});

test('updateDashboardSettings rejects duplicate widget key', async () => {
  const db = await freshDb();
  const result = await updateDashboardSettings(db, {
    widgetsOrder: ['rounds_today', 'stats_today', 'rounds_today'],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'widgets_order_duplicate_key');
});

// ---------------------------------------------------------------------------
// CHECK constraints (DB-level) — belt-and-suspenders for app-layer validation
// ---------------------------------------------------------------------------

test('CHECK: dashboard_settings rejects raw INSERT of a second row (singleton)', async () => {
  const db = await freshDb();
  // The migration already inserted id=1. A direct INSERT with another id
  // should fail the singleton CHECK.
  const { dashboardSettings: tbl } = await import('./schema/dashboard-settings');
  await assert.rejects(
    () => db.insert(tbl).values({ id: 2 }).execute(),
    /dashboard_settings_singleton|violates check/i,
  );
});

// ---------------------------------------------------------------------------
// applyRevenuePrivacyGate — pure function, no DB
// ---------------------------------------------------------------------------

const baseStats = {
  revenueIls: 1234,
  revenueDeltaPct: 12,
  bookingsCount: 24,
  bookingsDelta: 3,
  activeHoldsCount: 5,
  punchCardsSold: 2,
  punchCardsDelta: -1,
  companionsCount: 4,
  companionsDelta: 2,
};

test('privacy gate: admin + showRevenue=true → revenue passes through', () => {
  const out = applyRevenuePrivacyGate(baseStats, { showRevenue: true, requesterRole: 'admin' });
  assert.equal(out.revenueIls, 1234);
  assert.equal(out.revenueDeltaPct, 12);
});

test('privacy gate: manager + showRevenue=true → revenue passes through', () => {
  const out = applyRevenuePrivacyGate(baseStats, { showRevenue: true, requesterRole: 'manager' });
  assert.equal(out.revenueIls, 1234);
});

test('privacy gate: admin + showRevenue=false → revenue stripped', () => {
  const out = applyRevenuePrivacyGate(baseStats, { showRevenue: false, requesterRole: 'admin' });
  assert.equal(out.revenueIls, undefined);
  assert.equal(out.revenueDeltaPct, undefined);
  // Other fields untouched
  assert.equal(out.bookingsCount, 24);
  assert.equal(out.activeHoldsCount, 5);
});

test('privacy gate: cashier role → revenue stripped even when showRevenue=true', () => {
  // Defence in depth: route gate currently blocks cashiers entirely, but
  // if a future change opens the route to other roles, revenue stays gated.
  const out = applyRevenuePrivacyGate(baseStats, { showRevenue: true, requesterRole: 'cashier' });
  assert.equal(out.revenueIls, undefined);
  assert.equal(out.revenueDeltaPct, undefined);
  assert.equal(out.bookingsCount, 24, 'non-revenue fields still present');
});

// ---------------------------------------------------------------------------
// validateDashboardSettingsPatch — coverage of edge cases (pure)
// ---------------------------------------------------------------------------

test('validate: empty patch returns null (no errors)', () => {
  const current = {
    id: 1,
    refreshIntervalSeconds: 30,
    showRevenue: true,
    showWeekAhead: true,
    capacityWarningPct: 70,
    capacityDangerPct: 90,
    widgetsOrder: ['rounds_today'],
    updatedAt: new Date(),
  };
  assert.equal(validateDashboardSettingsPatch(current, {}), null);
});

test('validate: refresh interval non-integer rejected', () => {
  const current = {
    id: 1,
    refreshIntervalSeconds: 30,
    showRevenue: true,
    showWeekAhead: true,
    capacityWarningPct: 70,
    capacityDangerPct: 90,
    widgetsOrder: ['rounds_today'],
    updatedAt: new Date(),
  };
  const err = validateDashboardSettingsPatch(current, { refreshIntervalSeconds: 30.5 });
  assert.ok(err);
  assert.equal(err?.code, 'refresh_interval_out_of_range');
});
