// Guards the booking-clarity additions Yanay asked for (2026-07-17). The
// customer app's test runner is `node --test --import tsx` with no React
// renderer, so — like CheckoutComplete-copy.test.ts — these are
// source-structure guards: they pin the behaviour that must not silently
// regress, not the pixels. Run by `pnpm -F @memesh/customer test`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, 'CustomerApp.tsx');

const read = () => readFile(SOURCE, 'utf8');

test('booking is gated on the rules popup, not a bare confirm (Yanay 2026-07-17)', async () => {
  const src = await read();
  // The confirm button must open the rules popup (setShowRules(true)), never
  // call doBook directly — the popup acknowledgment is the gate. doBook then
  // runs only from the popup's onAcknowledge, before the punch booking call.
  assert.ok(
    src.includes('onClick={() => setShowRules(true)}'),
    'the confirm button must open the rules popup',
  );
  assert.ok(
    !src.includes('onClick={() => void doBook()}'),
    'the confirm button must not call doBook directly (it would skip the popup)',
  );
  const modal = src.indexOf('<PreBookingInfoModal');
  const bookSource = src.indexOf('source="book"');
  const ackBook = src.indexOf('void doBook();');
  assert.ok(modal !== -1 && bookSource !== -1, 'the booking flow must render the rules popup');
  assert.ok(ackBook !== -1, 'the popup must run doBook on acknowledge');
});

test('reschedule is gated on the same rules popup (Yanay 2026-07-17)', async () => {
  const src = await read();
  // Choosing a swap target must stash it and open the popup, not swap outright.
  assert.ok(
    src.includes('onClick={() => setPendingSwap(r.roundInstanceId)}'),
    'a swap target must open the rules popup instead of swapping directly',
  );
  assert.ok(
    src.includes('source="reschedule"'),
    'the reschedule flow must render the rules popup',
  );
  assert.ok(
    src.includes('void doSwap(target)'),
    'the popup must run the pending swap on acknowledge',
  );
});

test('the booking-clarity content keys stay wired', async () => {
  const src = await read();
  // Each string is an admin-editable key Yanay owns; if a t() call site is
  // removed the copy silently vanishes from the flow. Pin the wiring.
  for (const key of [
    'customer.cards.notReservationNote', // #2 punch card is not a reservation
    'customer.bookflow.roundIntro', // #3 how a round works
    'customer.bookflow.capacityNote', // #8 what "available seats" counts
    'customer.bookflow.companionPolicy', // #5 companion rule
    'customer.bookflow.summaryTitle', // #4 + #9 order summary
    'customer.bookflow.summaryTotal',
    'customer.bookflow.termsUrl', // rules-popup terms link target
    'customer.bookflow.confirmedRecap', // #10 post-booking recap
  ]) {
    assert.match(src, new RegExp(key.replace(/\./g, '\\.')), `missing t('${key}')`);
  }
});

test('the rules popup renders all six sections + acknowledge from the registry', async () => {
  const src = await read();
  // The popup copy is admin-editable; pin the header, CTA and footer terms
  // so a refactor can't silently drop them.
  for (const key of [
    'customer.infopopup.title',
    'customer.infopopup.continue',
    'customer.infopopup.termsPrefix',
    'customer.infopopup.termsLink',
    'customer.infopopup.closeLabel',
  ]) {
    assert.match(src, new RegExp(key.replace(/\./g, '\\.')), `missing t('${key}')`);
  }
  // The six sections are rendered from INFO_SECTIONS via a template key.
  assert.match(src, /customer\.infopopup\.\$\{s\.stem\}\.title/, 'section titles must be wired');
  assert.match(src, /customer\.infopopup\.\$\{s\.stem\}\.body/, 'section bodies must be wired');
  assert.match(
    src,
    /\{ stem: 's1'.*\}[\s\S]*\{ stem: 's6'/,
    'INFO_SECTIONS must define s1 through s6',
  );
});

test('the total headcount counts a companion per child plus the paid extra (Yanay #4/#9)', async () => {
  const src = await read();
  // Punch entries are one child + one included companion each, so the total is
  // count*2, plus the single paid extra companion when it applies.
  assert.match(
    src,
    /summaryTotal',\s*\{\s*count:\s*count\s*\*\s*2\s*\+\s*extra\s*\}/,
    'total must be count*2 + extra',
  );
});

test('past bookings never offer cancel / reschedule (Yanay 2026-07-18)', async () => {
  const src = await read();
  // isPast compares the round's start to venue-time "now" (Asia/Jerusalem), and
  // the action block must be gated on it — a round that already started can be
  // neither cancelled nor rescheduled.
  assert.match(
    src,
    /const isPast = `\$\{booking\.date\} \$\{booking\.startTime\}` < nowVenue/,
    'isPast must compare the round start to venue-time now',
  );
  assert.match(src, /timeZone: 'Asia\/Jerusalem'/, 'venue now must use Asia/Jerusalem');
  assert.match(
    src,
    /booking\.status === 'confirmed' && !isPast &&/,
    'the cancel/reschedule block must be gated on !isPast',
  );
});
