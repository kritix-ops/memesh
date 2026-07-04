import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addIsoDays,
  isBeforeRoundStart,
  isoWeekday,
  isWithinCancelWindow,
  venueStartOfDay,
  venueTodayIso,
} from './round-time';

// Israel is UTC+3 in July (IDT). Intl handles the offset, so these are
// machine-timezone independent.

test('isBeforeRoundStart: true before the venue-local start, false after', () => {
  // Round at 2026-07-01 16:00 Israel.
  assert.equal(isBeforeRoundStart('2026-07-01', '16:00', new Date('2026-07-01T07:00:00Z')), true); // 10:00 IDT
  assert.equal(isBeforeRoundStart('2026-07-01', '16:00', new Date('2026-07-01T14:00:00Z')), false); // 17:00 IDT
});

test('isWithinCancelWindow: true beyond the window, false inside it', () => {
  // Round at 2026-07-02 16:00 Israel, 24h window.
  assert.equal(isWithinCancelWindow('2026-07-02', '16:00', 24, new Date('2026-07-01T07:00:00Z')), true); // ~30h before
  assert.equal(isWithinCancelWindow('2026-07-02', '16:00', 24, new Date('2026-07-02T07:00:00Z')), false); // ~6h before
});

test('venueTodayIso: the venue calendar date, not the server one', () => {
  // 21:10Z on Saturday Jul 4 is already 00:10 Sunday Jul 5 in Israel — the
  // exact production gap this helper exists for (Yoav 2026-07-05).
  assert.equal(venueTodayIso(new Date('2026-07-04T21:10:00Z')), '2026-07-05');
  assert.equal(venueTodayIso(new Date('2026-07-04T20:59:00Z')), '2026-07-04');
  // Winter (IST, UTC+2): the flip happens at 22:00Z instead.
  assert.equal(venueTodayIso(new Date('2026-01-15T22:30:00Z')), '2026-01-16');
  assert.equal(venueTodayIso(new Date('2026-01-15T21:30:00Z')), '2026-01-15');
});

test('venueStartOfDay: the instant venue midnight happened', () => {
  // Summer: 00:00 IDT Jul 5 = 21:00Z Jul 4, whether asked just after midnight
  // or the following midday.
  assert.equal(venueStartOfDay(new Date('2026-07-04T21:10:00Z')).toISOString(), '2026-07-04T21:00:00.000Z');
  assert.equal(venueStartOfDay(new Date('2026-07-05T10:00:00Z')).toISOString(), '2026-07-04T21:00:00.000Z');
  // Winter: 00:00 IST Jan 16 = 22:00Z Jan 15.
  assert.equal(venueStartOfDay(new Date('2026-01-15T22:30:00Z')).toISOString(), '2026-01-15T22:00:00.000Z');
});

test('addIsoDays: pure calendar math across month and year boundaries', () => {
  assert.equal(addIsoDays('2026-07-05', 0), '2026-07-05');
  assert.equal(addIsoDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addIsoDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addIsoDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addIsoDays('2026-07-05', 29), '2026-08-03');
});

test('isoWeekday: 0=Sunday … 6=Saturday, matching the daysActive bitmask', () => {
  assert.equal(isoWeekday('2026-07-05'), 0); // Sunday
  assert.equal(isoWeekday('2026-07-09'), 4); // Thursday
  assert.equal(isoWeekday('2026-07-04'), 6); // Saturday
});
