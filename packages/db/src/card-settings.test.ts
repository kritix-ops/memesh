import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { listStaffActions } from './actions';
import { getCardSettings, updateCardSettings } from './card-settings';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

test('getCardSettings returns the seeded singleton with defaults', async () => {
  const db = await freshDb();
  const s = await getCardSettings(db);
  assert.equal(s.priceShekels, 320);
  assert.equal(s.validityDays, 365);
  assert.equal(s.totalEntries, 12);
  assert.equal(s.pitchLabel, 'משלמים על 10, מקבלים 12 · תקף לשנה');
  assert.equal(s.singleton, true);
});

test('getCardSettings is idempotent: a second call returns the same row', async () => {
  const db = await freshDb();
  const a = await getCardSettings(db);
  const b = await getCardSettings(db);
  assert.equal(a.id, b.id);
});

test('updateCardSettings persists changed fields and returns a diff', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { priceShekels: 350, totalEntries: 10 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.priceShekels, 350);
  assert.equal(res.row.totalEntries, 10);
  // Unchanged fields stay at their defaults.
  assert.equal(res.row.validityDays, 365);
  assert.deepEqual(res.diff.priceShekels, [320, 350]);
  assert.deepEqual(res.diff.totalEntries, [12, 10]);
});

test('updateCardSettings trims pitch label and records the change', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { pitchLabel: '  כרטיסייה משתלמת · 12 כניסות  ' });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.pitchLabel, 'כרטיסייה משתלמת · 12 כניסות');
});

test('updateCardSettings rejects out-of-range price', async () => {
  const db = await freshDb();
  const tooHigh = await updateCardSettings(db, { priceShekels: 99999 });
  assert.equal(tooHigh.ok, false);
  if (!tooHigh.ok) assert.equal(tooHigh.error, 'price_out_of_range');
  const negative = await updateCardSettings(db, { priceShekels: -1 });
  assert.equal(negative.ok, false);
  if (!negative.ok) assert.equal(negative.error, 'price_out_of_range');
});

test('updateCardSettings rejects validity 0 and entries 0', async () => {
  const db = await freshDb();
  const v = await updateCardSettings(db, { validityDays: 0 });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.error, 'validity_out_of_range');
  const e = await updateCardSettings(db, { totalEntries: 0 });
  assert.equal(e.ok, false);
  if (!e.ok) assert.equal(e.error, 'entries_out_of_range');
});

test('updateCardSettings rejects empty pitch label after trim', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { pitchLabel: '   ' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'pitch_length');
});

test('updateCardSettings returns no_changes when patch is a no-op', async () => {
  const db = await freshDb();
  // Default price is 320; sending the same value should not log.
  const res = await updateCardSettings(db, { priceShekels: 320 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'no_changes');
  const actions = await listStaffActions(db);
  assert.equal(actions.filter((a) => a.action === 'update_card_settings').length, 0);
});

test('updateCardSettings logs a staff action with a Hebrew diff summary', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { priceShekels: 340, totalEntries: 10 });
  assert.equal(res.ok, true);
  const actions = await listStaffActions(db);
  const entry = actions.find((a) => a.action === 'update_card_settings');
  assert.ok(entry, 'expected update_card_settings action to be logged');
  assert.match(entry!.summary, /מחיר 320→340/);
  assert.match(entry!.summary, /כניסות 12→10/);
});
