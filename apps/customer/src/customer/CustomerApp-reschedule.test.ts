// Tests for the reschedule flow (Yanay 2026-07-09): a booking can move to any
// open round on any day in the booking window — not just another time on the
// same day — defaulting the picker to the booking's own date. The timing rule
// (swap allowed until the ORIGINAL round starts) lives in the server
// (packages/db/src/rounds-swap.ts) and is covered by its own tests; here we
// pin the two pure helpers plus source-structure contracts, in the repo's
// no-React-renderer style. Importing CustomerApp.tsx pulls @memesh/brand's
// .png assets, so the test script registers brand's png-stub loader first.
// Run by `pnpm -F @memesh/customer test`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AvailabilityRound, DayAvailability } from '../lib/api/rounds';
import { pickInitialDate, swapTargetsForDay } from './CustomerApp';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, 'CustomerApp.tsx');

const round = (over: Partial<AvailabilityRound>): AvailabilityRound => ({
  roundInstanceId: 'r1',
  label: 'בוקר',
  startTime: '09:00',
  endTime: '14:00',
  capacity: 60,
  available: 10,
  isClosed: false,
  ...over,
});

const day = (rounds: AvailabilityRound[], over: Partial<DayAvailability> = {}): DayAvailability => ({
  date: '2026-07-12',
  roundsRequired: true,
  closed: false,
  rounds,
  ...over,
});

// ---- pickInitialDate --------------------------------------------------------

const WINDOW = ['2026-07-10', '2026-07-11', '2026-07-12'];

test('pickInitialDate: keeps the current selection while it is in the window', () => {
  assert.equal(pickInitialDate(WINDOW, '2026-07-11', '2026-07-12'), '2026-07-11');
});

test('pickInitialDate: prefers the default (the booking date) over today', () => {
  assert.equal(pickInitialDate(WINDOW, null, '2026-07-12'), '2026-07-12');
});

test('pickInitialDate: falls back to the first day when the default left the window', () => {
  // A booking whose date already passed (or moved beyond the strip) must not
  // select a chip that does not exist — today is the honest fallback.
  assert.equal(pickInitialDate(WINDOW, null, '2026-07-01'), '2026-07-10');
  assert.equal(pickInitialDate(WINDOW, null, undefined), '2026-07-10');
});

test('pickInitialDate: empty window yields null, never a phantom date', () => {
  assert.equal(pickInitialDate([], null, '2026-07-12'), null);
});

// ---- swapTargetsForDay ------------------------------------------------------

test('swapTargetsForDay: excludes the round the booking already sits in', () => {
  const d = day([round({ roundInstanceId: 'mine' }), round({ roundInstanceId: 'other' })]);
  assert.deepEqual(
    swapTargetsForDay(d, 'mine').map((r) => r.roundInstanceId),
    ['other'],
  );
});

test('swapTargetsForDay: drops full and closed rounds', () => {
  const d = day([
    round({ roundInstanceId: 'full', available: 0 }),
    round({ roundInstanceId: 'closed', isClosed: true }),
    round({ roundInstanceId: 'open' }),
  ]);
  assert.deepEqual(
    swapTargetsForDay(d, 'elsewhere').map((r) => r.roundInstanceId),
    ['open'],
  );
});

test('swapTargetsForDay: a different day offers every open round, none excluded', () => {
  // The booking's own round id can only appear on its own day; on other days
  // all open rounds are valid targets.
  const d = day([round({ roundInstanceId: 'a' }), round({ roundInstanceId: 'b' })]);
  assert.equal(swapTargetsForDay(d, 'mine').length, 2);
});

test('swapTargetsForDay: same-day-with-one-round yields the dead-end the UI must message', () => {
  // The exact scenario Yanay screenshotted: one round that day, and it is the
  // booking's own — zero targets. The UI copy points at picking another day.
  const d = day([round({ roundInstanceId: 'mine' })]);
  assert.deepEqual(swapTargetsForDay(d, 'mine'), []);
});

// ---- source contracts -------------------------------------------------------

test('the reschedule button offers a date change, not just a time change', async () => {
  const src = await readFile(SOURCE, 'utf8');
  assert.match(src, /שנה מועד/, 'button must read "שנה מועד"');
  assert.doesNotMatch(
    src,
    /לאותו יום/,
    'no picker may limit the swap to the same day — the server never did',
  );
});

test('both pickers share the one availability window (SSOT guard)', async () => {
  const src = await readFile(SOURCE, 'utf8');
  const uses = [...src.matchAll(/useRoundAvailabilityWindow\(/g)].length;
  // One declaration + two call sites (punch booking, reschedule). A dropped
  // call site means one flow grew its own copy of the window logic again.
  assert.ok(
    uses >= 3,
    `expected the hook declared once and used by both flows, found ${uses} occurrences`,
  );
});

test('a successful reschedule lands with visible feedback (Yanay 2026-07-10)', async () => {
  // The swapped booking re-sorts into its new date slot; without a ribbon,
  // a scroll-to and a forced-open card, the change read as "it just jumped
  // somewhere". These pins keep the landing point visible.
  const src = await readFile(SOURCE, 'utf8');
  assert.match(src, /המועד שונה בהצלחה/, 'the success ribbon must exist');
  assert.match(
    src,
    /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/,
    'the moved card must scroll into view',
  );
  // onMoved must fire only AFTER the list reload, so the highlight targets
  // the re-sorted list, not the stale one.
  assert.match(
    src,
    /await onSwapped\(\);\n(\s*\/\/[^\n]*\n)*\s*onMoved\?\.\(\);/,
    'onMoved must follow the awaited onSwapped reload',
  );
});
