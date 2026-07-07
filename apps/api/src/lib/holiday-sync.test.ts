// Orchestrator: Hebcal (faked) → policy upsert → rule regeneration, and the
// browse-calendar join. Runs against a real schema in PGlite via the db
// package's migration folder. @memesh/db reads DATABASE_URL at import, so it (and
// holiday-sync, which pulls it in) is imported dynamically after env is set.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/memesh';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { HebcalClient } from './hebcal-client.js';
import type { HolidaySyncDeps } from './holiday-sync.js';

const { holidayPolicies, MIGRATIONS_FOLDER, roundScheduleRules, setHolidayPolicy } = await import('@memesh/db');
const { buildHolidayCalendar, runHolidaySync } = await import('./holiday-sync.js');

const NOW = new Date(2026, 6, 1, 12, 0, 0);

const fakeHebcal = (): HebcalClient => ({
  listHolidays: async (year) => [
    { date: `${year}-04-02`, englishTitle: 'Pesach I', hebrewName: 'פסח א׳', subcat: 'major', yomtov: true },
    { date: `${year}-04-03`, englishTitle: "Pesach II (CH''M)", hebrewName: 'פסח ב׳', subcat: 'major', yomtov: false },
    { date: `${year}-09-21`, englishTitle: 'Yom Kippur', hebrewName: 'יום כיפור', subcat: 'major', yomtov: true },
  ],
  listCandleLighting: async (year) => [
    { date: `${year}-07-03`, time: '19:11' },
    { date: `${year}-07-10`, time: '19:09' },
  ],
});

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

const deps = (db: Awaited<ReturnType<typeof freshDb>>): HolidaySyncDeps => ({
  db,
  hebcal: fakeHebcal(),
  geo: { kind: 'geoname', geonameid: 293397 },
});

test('runHolidaySync seeds policies and creates zero rules until something is confirmed', async () => {
  const db = await freshDb();
  const res = await runHolidaySync(deps(db), 2026, NOW);
  assert.equal(res.holidays, 3);
  assert.equal(res.fridays, 2);
  assert.equal(res.policiesInserted, 3);
  assert.equal(res.rulesCreated, 0); // fail-open: nothing confirmed

  const policies = await db.select().from(holidayPolicies);
  assert.equal(policies.length, 4); // 3 holidays + shabbat
});

test('confirming a closed holiday then syncing produces exactly one closure rule', async () => {
  const db = await freshDb();
  await runHolidaySync(deps(db), 2026, NOW);
  await setHolidayPolicy(db, 'yom_kippur', { policy: 'closed', confirmed: true }, NOW);

  const res = await runHolidaySync(deps(db), 2026, NOW);
  assert.equal(res.rulesCreated, 1);
  const rules = await db.select().from(roundScheduleRules).where(eq(roundScheduleRules.dateFrom, '2026-09-21'));
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.outside, 'closed');
});

test('buildHolidayCalendar joins Hebcal dates onto policies, including every Shabbat Friday', async () => {
  const db = await freshDb();
  await runHolidaySync(deps(db), 2026, NOW);

  const cal = await buildHolidayCalendar(deps(db), 2026);
  assert.equal(cal.year, 2026);
  assert.equal(cal.entries.length, 4); // 3 holidays + shabbat

  const shabbat = cal.entries.find((e) => e.holidayKey === 'shabbat')!;
  assert.deepEqual(shabbat.dates, ['2026-07-03', '2026-07-10']);
  assert.equal(shabbat.category, 'shabbat');

  const yk = cal.entries.find((e) => e.holidayKey === 'yom_kippur')!;
  assert.equal(yk.policy, 'normal');
  assert.equal(yk.confirmed, false);
  assert.deepEqual(yk.dates, ['2026-09-21']);
});
