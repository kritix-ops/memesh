// Holiday-closure sync core: policy upsert, idempotent rule regeneration, and
// the fail-open safety invariant (an unconfirmed or normal holiday never closes
// the venue). Runs against a real schema in PGlite so migration 0028 is
// exercised end to end.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_SHABBAT_OFFSET_MIN,
  regenerateHolidaySyncRules,
  SHABBAT_KEY,
  subtractMinutes,
  upsertHolidayPolicies,
  type HolidayOccurrence,
} from './holiday-policies';
import { createScheduleRule } from './rounds-schedule';
import { holidayPolicies, roundScheduleRules } from './schema';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const NOW = new Date(2026, 6, 1, 12, 0, 0);

const OCC_2026: HolidayOccurrence[] = [
  { holidayKey: 'pesach_i', hebrewName: 'פסח א׳', category: 'major', yomtov: true, date: '2026-04-02' },
  { holidayKey: 'pesach_ii', hebrewName: 'פסח ב׳ (חוה״מ)', category: 'major', yomtov: false, date: '2026-04-03' },
  { holidayKey: 'yom_kippur', hebrewName: 'יום כיפור', category: 'major', yomtov: true, date: '2026-09-21' },
];

/** Confirm a policy the way the admin API will: set state + confirmed_at. */
async function confirm(
  db: Awaited<ReturnType<typeof freshDb>>,
  key: string,
  patch: Record<string, unknown>,
) {
  await db
    .update(holidayPolicies)
    .set({ confirmedAt: NOW, updatedAt: NOW, ...patch })
    .where(eq(holidayPolicies.holidayKey, key));
}

test('subtractMinutes handles normal, wrap, and clamp', () => {
  assert.equal(subtractMinutes('19:11', 40), '18:31');
  assert.equal(subtractMinutes('19:00', 90), '17:30');
  assert.equal(subtractMinutes('00:20', 40), '00:00'); // clamp, never negative
});

test('upsert seeds new holidays as normal + unconfirmed and creates the Shabbat row', async () => {
  const db = await freshDb();
  const res = await upsertHolidayPolicies(db, OCC_2026, NOW);
  assert.deepEqual(res, { inserted: 3, refreshed: 0 });

  const all = await db.select().from(holidayPolicies);
  // 3 holidays + the weekly shabbat row.
  assert.equal(all.length, 4);
  const yk = all.find((p) => p.holidayKey === 'yom_kippur')!;
  assert.equal(yk.policy, 'normal');
  assert.equal(yk.confirmedAt, null);
  const shabbat = all.find((p) => p.holidayKey === SHABBAT_KEY)!;
  assert.equal(shabbat.category, 'shabbat');
  assert.equal(shabbat.shabbatCloseOffsetMinutes, DEFAULT_SHABBAT_OFFSET_MIN);
});

test('re-upsert refreshes display metadata but never touches Yanay\'s decision', async () => {
  const db = await freshDb();
  await upsertHolidayPolicies(db, OCC_2026, NOW);
  await confirm(db, 'yom_kippur', { policy: 'closed' });

  // Next year's sync: same key, tweaked Hebrew name.
  const res = await upsertHolidayPolicies(
    db,
    [{ ...OCC_2026[2]!, hebrewName: 'יום הכיפורים' }],
    new Date(2027, 0, 1),
  );
  assert.deepEqual(res, { inserted: 0, refreshed: 1 });

  const yk = (await db.select().from(holidayPolicies).where(eq(holidayPolicies.holidayKey, 'yom_kippur')))[0]!;
  assert.equal(yk.hebrewName, 'יום הכיפורים'); // metadata refreshed
  assert.equal(yk.policy, 'closed'); // decision preserved
  assert.ok(yk.confirmedAt); // confirmation preserved
});

test('SAFETY: unconfirmed and normal policies generate zero closure rows', async () => {
  const db = await freshDb();
  await upsertHolidayPolicies(db, OCC_2026, NOW);
  // Nothing confirmed yet.
  let res = await regenerateHolidaySyncRules(db, { year: 2026, occurrences: OCC_2026, fridays: [] }, NOW);
  assert.deepEqual(res, { deleted: 0, created: 0 });

  // Confirm one as explicitly 'normal' — still nothing.
  await confirm(db, 'pesach_ii', { policy: 'normal' });
  res = await regenerateHolidaySyncRules(db, { year: 2026, occurrences: OCC_2026, fridays: [] }, NOW);
  assert.equal(res.created, 0);
  const rules = await db.select().from(roundScheduleRules);
  assert.equal(rules.length, 0);
});

test('confirmed closed + special_hours generate the right rules', async () => {
  const db = await freshDb();
  await upsertHolidayPolicies(db, OCC_2026, NOW);
  await confirm(db, 'yom_kippur', { policy: 'closed' });
  await confirm(db, 'pesach_ii', { policy: 'special_hours', openTime: '09:00', closeTime: '13:00' });

  const res = await regenerateHolidaySyncRules(db, { year: 2026, occurrences: OCC_2026, fridays: [] }, NOW);
  assert.equal(res.created, 2);

  const rules = await db.select().from(roundScheduleRules);
  const closed = rules.find((r) => r.dateFrom === '2026-09-21')!;
  assert.equal(closed.outside, 'closed');
  assert.equal(closed.source, 'holiday_sync');
  assert.equal(closed.sourceKey, 'yom_kippur:2026');

  const special = rules.find((r) => r.dateFrom === '2026-04-03')!;
  assert.equal(special.outside, 'free_play');
  assert.equal(special.openFrom?.slice(0, 5), '09:00');
  assert.equal(special.openUntil?.slice(0, 5), '13:00');
});

test('Shabbat generates a per-Friday early-close from candle time minus offset', async () => {
  const db = await freshDb();
  await upsertHolidayPolicies(db, [], NOW);
  await confirm(db, SHABBAT_KEY, { policy: 'special_hours', shabbatCloseOffsetMinutes: 40, openTime: '10:00' });

  const fridays = [
    { date: '2026-07-03', candleTime: '19:11' },
    { date: '2026-07-10', candleTime: '19:09' },
  ];
  const res = await regenerateHolidaySyncRules(db, { year: 2026, occurrences: [], fridays }, NOW);
  assert.equal(res.created, 2);

  const rule = (await db.select().from(roundScheduleRules).where(eq(roundScheduleRules.dateFrom, '2026-07-03')))[0]!;
  assert.equal(rule.outside, 'free_play');
  assert.equal(rule.openFrom?.slice(0, 5), '10:00');
  assert.equal(rule.openUntil?.slice(0, 5), '18:31'); // 19:11 - 40m
  assert.equal(rule.sourceKey, 'shabbat:2026-07-03');
});

test('a chag on a Friday wins over the generic Shabbat early-close (no double rule)', async () => {
  const db = await freshDb();
  // Erev-style holiday landing on a Friday.
  const occ: HolidayOccurrence[] = [
    { holidayKey: 'erev_pesach', hebrewName: 'ערב פסח', category: 'major', yomtov: false, date: '2026-04-03' },
  ];
  await upsertHolidayPolicies(db, occ, NOW);
  await confirm(db, 'erev_pesach', { policy: 'closed' });
  await confirm(db, SHABBAT_KEY, { policy: 'special_hours', shabbatCloseOffsetMinutes: 40 });

  const res = await regenerateHolidaySyncRules(
    db,
    { year: 2026, occurrences: occ, fridays: [{ date: '2026-04-03', candleTime: '18:40' }] },
    NOW,
  );
  const rulesForDate = await db.select().from(roundScheduleRules).where(eq(roundScheduleRules.dateFrom, '2026-04-03'));
  assert.equal(rulesForDate.length, 1); // only the chag, not chag + shabbat
  assert.equal(rulesForDate[0]!.outside, 'closed');
  assert.equal(res.created, 1);
});

test('regeneration is idempotent and never touches manual rows', async () => {
  const db = await freshDb();
  // A manual closure the admin authored by hand.
  const manual = await createScheduleRule(
    db,
    { dateFrom: '2026-05-01', windows: [], outside: 'closed', note: 'שיפוצים' },
    NOW,
  );
  assert.ok(manual.ok);

  await upsertHolidayPolicies(db, OCC_2026, NOW);
  await confirm(db, 'yom_kippur', { policy: 'closed' });

  const first = await regenerateHolidaySyncRules(db, { year: 2026, occurrences: OCC_2026, fridays: [] }, NOW);
  assert.deepEqual(first, { deleted: 0, created: 1 });

  // Second run deletes its own prior row and recreates it — stable count.
  const second = await regenerateHolidaySyncRules(db, { year: 2026, occurrences: OCC_2026, fridays: [] }, NOW);
  assert.deepEqual(second, { deleted: 1, created: 1 });

  const all = await db.select().from(roundScheduleRules);
  assert.equal(all.length, 2); // manual + the one sync row, no accumulation
  const manualStillThere = all.find((r) => r.source === 'manual');
  assert.ok(manualStillThere);
  assert.equal(manualStillThere!.note, 'שיפוצים');
});
