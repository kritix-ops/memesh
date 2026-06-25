// Pure-logic tests for the post-sale mark-entry prompt. The staff app's
// test runner is `node --test --import tsx` with no React renderer wired,
// so component instantiation is out of scope. We pin the two pure helpers
// (`clampCustomAmount`, `entriesForTile`) plus a source-structure guard
// that documents the "no default selection" contract from the spec
// (_plans/2026-06-25-pos-sell-mark-entry-prompt.md).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { clampCustomAmount, entriesForTile } from './MarkEntryAtSale';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, 'MarkEntryAtSale.tsx');

test('clampCustomAmount: returns 1 for values below 1', () => {
  assert.equal(clampCustomAmount(0, 12), 1);
  assert.equal(clampCustomAmount(-3, 12), 1);
});

test('clampCustomAmount: clamps to maxEntries', () => {
  assert.equal(clampCustomAmount(15, 12), 12);
  assert.equal(clampCustomAmount(12, 12), 12);
});

test('clampCustomAmount: passes through valid in-range values, truncating fractions', () => {
  assert.equal(clampCustomAmount(3, 12), 3);
  assert.equal(clampCustomAmount(5.9, 12), 5);
});

test('clampCustomAmount: floors maxEntries at 1 so the picker is always operable', () => {
  // Pathological — a card with zero remaining shouldn't reach the prompt,
  // but if it does the picker still surfaces 1 rather than dividing-by-zero
  // the UI. The server caps again on submit.
  assert.equal(clampCustomAmount(5, 0), 1);
  assert.equal(clampCustomAmount(5, -2), 1);
});

test('clampCustomAmount: non-finite inputs (NaN, Infinity) fall back to 1', () => {
  // Both NaN and Infinity fail Number.isFinite, so the helper collapses
  // them to the safe minimum. Treating Infinity as "max" would silently
  // try to draw the full card on a UI glitch.
  assert.equal(clampCustomAmount(Number.NaN, 12), 1);
  assert.equal(clampCustomAmount(Number.POSITIVE_INFINITY, 12), 1);
  assert.equal(clampCustomAmount(Number.NEGATIVE_INFINITY, 12), 1);
});

test('entriesForTile: skip returns 0', () => {
  assert.equal(entriesForTile('skip', 5, 12), 0);
});

test('entriesForTile: quick-pick 1 and 2 return their literal values', () => {
  assert.equal(entriesForTile(1, 99, 12), 1);
  assert.equal(entriesForTile(2, 99, 12), 2);
});

test('entriesForTile: the "2" tile clamps when the card has only 1 entry left', () => {
  // The component disables the "2" tile when ceiling < 2, but if it ever
  // dispatched anyway we still must not over-draw. The min() guard here
  // is the belt to the disabled-button suspenders.
  assert.equal(entriesForTile(2, 0, 1), 1);
});

test('entriesForTile: custom routes through clampCustomAmount', () => {
  assert.equal(entriesForTile('custom', 0, 12), 1);
  assert.equal(entriesForTile('custom', 7, 12), 7);
  assert.equal(entriesForTile('custom', 15, 12), 12);
});

test('source contract: no default selection — useState starts at null/closed', async () => {
  // The "must pick" requirement is impossible to express with the runner
  // we have, so we pin the source: the local custom-picker substate
  // starts closed (`useState(false)`) and the busy/picked tile state is
  // owned by the parent (`busyTile` prop, no useState here). If a future
  // edit pre-selects a tile or pre-opens the custom picker, this test
  // catches it before the spec breaks.
  const src = await readFile(SOURCE, 'utf8');
  assert.ok(
    src.includes("useState(false)"),
    'expected the custom picker to start closed (useState(false))',
  );
  assert.ok(
    !/useState<MarkEntryTile\s*\|\s*null>\(/.test(src) &&
      !/useState<MarkEntryTile>\(/.test(src),
    'MarkEntryAtSale must not own the picked-tile state — the parent owns it (busyTile prop) so "no default" is testable from PosApp',
  );
});

test('source contract: punch happens through the parent, not in the component', async () => {
  const src = await readFile(SOURCE, 'utf8');
  assert.ok(
    !src.includes('punchBySerial') && !src.includes('punchByToken'),
    'MarkEntryAtSale must be pure UI — the parent owns the punch call so the idempotency key lives in one place',
  );
});
