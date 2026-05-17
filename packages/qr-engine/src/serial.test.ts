import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSerial, parseSerial } from './serial.js';

test('generateSerial pads sequence to 4 digits', () => {
  const date = new Date(Date.UTC(2026, 4, 17));
  assert.equal(generateSerial({ date, sequence: 1 }), 'M-20260517-0001');
  assert.equal(generateSerial({ date, sequence: 42 }), 'M-20260517-0042');
  assert.equal(generateSerial({ date, sequence: 9999 }), 'M-20260517-9999');
});

test('generateSerial allows 5-digit sequences past 9999', () => {
  const date = new Date(Date.UTC(2026, 4, 17));
  assert.equal(generateSerial({ date, sequence: 10_000 }), 'M-20260517-10000');
  assert.equal(generateSerial({ date, sequence: 99_999 }), 'M-20260517-99999');
});

test('generateSerial throws RangeError on invalid sequence', () => {
  const date = new Date(Date.UTC(2026, 4, 17));
  assert.throws(() => generateSerial({ date, sequence: 0 }), RangeError);
  assert.throws(() => generateSerial({ date, sequence: -1 }), RangeError);
  assert.throws(() => generateSerial({ date, sequence: 100_000 }), RangeError);
  assert.throws(() => generateSerial({ date, sequence: 1.5 }), RangeError);
});

test('parseSerial roundtrips with generateSerial', () => {
  const date = new Date(Date.UTC(2026, 4, 17));
  const serial = generateSerial({ date, sequence: 42 });
  const parsed = parseSerial(serial);
  assert.notEqual(parsed, undefined);
  if (parsed) {
    assert.equal(parsed.date.getTime(), date.getTime());
    assert.equal(parsed.sequence, 42);
  }
});

test('parseSerial returns undefined for malformed input', () => {
  assert.equal(parseSerial('not-a-serial'), undefined);
  assert.equal(parseSerial('M-2026-0001'), undefined);
  assert.equal(parseSerial(''), undefined);
  assert.equal(parseSerial('M-20260517-1'), undefined);
});
