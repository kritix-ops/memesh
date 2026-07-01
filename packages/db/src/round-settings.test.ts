import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getRoundSettings, updateRoundSettings, validateRoundSettingsPatch } from './round-settings';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

test('getRoundSettings returns the seeded defaults', async () => {
  const db = await freshDb();
  const s = await getRoundSettings(db);
  assert.equal(s.holdTtlMinutes, 15);
  assert.equal(s.cancellationWindowHours, 24);
  assert.equal(s.claimWindowMinutes, 60);
});

test('validateRoundSettingsPatch enforces ranges', () => {
  assert.equal(validateRoundSettingsPatch({ holdTtlMinutes: 0 })?.code, 'hold_ttl_out_of_range');
  assert.equal(validateRoundSettingsPatch({ holdTtlMinutes: 999 })?.code, 'hold_ttl_out_of_range');
  assert.equal(validateRoundSettingsPatch({ claimWindowMinutes: 0 })?.code, 'claim_window_out_of_range');
  assert.equal(
    validateRoundSettingsPatch({ cancellationWindowHours: -1 })?.code,
    'cancellation_window_out_of_range',
  );
  assert.equal(validateRoundSettingsPatch({ holdTtlMinutes: 20, cancellationWindowHours: 48 }), null);
});

test('updateRoundSettings persists changes and reports a diff', async () => {
  const db = await freshDb();
  const res = await updateRoundSettings(db, { holdTtlMinutes: 20 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.holdTtlMinutes, 20);
  assert.deepEqual(res.diff.holdTtlMinutes, [15, 20]);
  assert.equal((await getRoundSettings(db)).holdTtlMinutes, 20);
});

test('updateRoundSettings rejects an invalid patch without writing', async () => {
  const db = await freshDb();
  const res = await updateRoundSettings(db, { holdTtlMinutes: 0 });
  assert.equal(res.ok, false);
  assert.equal((await getRoundSettings(db)).holdTtlMinutes, 15);
});

test('updateRoundSettings with an identical value returns an empty diff', async () => {
  const db = await freshDb();
  const res = await updateRoundSettings(db, { holdTtlMinutes: 15 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.diff, {});
});
