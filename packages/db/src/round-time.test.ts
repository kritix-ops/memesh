import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBeforeRoundStart, isWithinCancelWindow } from './round-time';

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
