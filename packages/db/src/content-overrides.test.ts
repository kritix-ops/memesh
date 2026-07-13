import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentDefaults } from '@memesh/content';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  getContentOverrides,
  getMergedContent,
  updateContentOverrides,
  validateContentValue,
} from './content-overrides';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const CANCEL = 'customer.policy.cancel'; // long, placeholder {{hours}}
const BTN = 'customer.booking.cancelButton'; // short, no placeholders

test('getMergedContent returns registry defaults when nothing is overridden', async () => {
  const db = await freshDb();
  const merged = await getMergedContent(db);
  assert.equal(merged[BTN], contentDefaults[BTN]);
  assert.equal(merged[CANCEL], contentDefaults[CANCEL]);
  assert.deepEqual(await getContentOverrides(db), {});
});

test('an override wins in the merged map and is the only stored row', async () => {
  const db = await freshDb();
  const res = await updateContentOverrides(db, { [BTN]: 'ביטול' }, 'staff-1');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.changed, [BTN]);
  assert.equal((await getMergedContent(db))[BTN], 'ביטול');
  assert.deepEqual(await getContentOverrides(db), { [BTN]: 'ביטול' });
});

test('a blank value resets the key to its default (row deleted)', async () => {
  const db = await freshDb();
  await updateContentOverrides(db, { [BTN]: 'ביטול' });
  const reset = await updateContentOverrides(db, { [BTN]: '   ' });
  assert.equal(reset.ok, true);
  assert.deepEqual(await getContentOverrides(db), {});
  assert.equal((await getMergedContent(db))[BTN], contentDefaults[BTN]);
});

test('a valid {{hours}} placeholder is accepted for the cancel policy', async () => {
  const db = await freshDb();
  const res = await updateContentOverrides(db, { [CANCEL]: 'ביטול עד {{hours}} שעות לפני.' });
  assert.equal(res.ok, true);
});

test('unknown key, unknown placeholder, and over-length are rejected and write nothing', async () => {
  const db = await freshDb();

  const unknownKey = await updateContentOverrides(db, { 'no.such.key': 'x' });
  assert.equal(unknownKey.ok, false);
  if (!unknownKey.ok) assert.equal(unknownKey.error.code, 'unknown_key');

  const badPlaceholder = await updateContentOverrides(db, { [CANCEL]: 'עד {{foo}} שעות' });
  assert.equal(badPlaceholder.ok, false);
  if (!badPlaceholder.ok) assert.equal(badPlaceholder.error.code, 'unknown_placeholder');

  const tooLong = await updateContentOverrides(db, { [BTN]: 'א'.repeat(201) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error.code, 'value_too_long');

  // Fail-closed: nothing from any of the rejected batches was written.
  assert.deepEqual(await getContentOverrides(db), {});
});

test('a batch with one bad key writes none of its keys (fail closed)', async () => {
  const db = await freshDb();
  const res = await updateContentOverrides(db, { [BTN]: 'ביטול', 'no.such.key': 'x' });
  assert.equal(res.ok, false);
  assert.deepEqual(await getContentOverrides(db), {});
});

test('validateContentValue is pure and matches the registry', () => {
  assert.equal(validateContentValue(BTN, 'ביטול'), null);
  assert.equal(validateContentValue('no.such.key', 'x')?.code, 'unknown_key');
  assert.equal(validateContentValue(CANCEL, 'עד {{foo}}')?.code, 'unknown_placeholder');
});
