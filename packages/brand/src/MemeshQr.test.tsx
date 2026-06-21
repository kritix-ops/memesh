import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement } from 'react';
import { MemeshQr } from './qr';

// The wrapper exists so all card surfaces share one QR config. These tests
// guard the props we actually care about — encoding settings that affect
// scannability — by inspecting the React element the component returns.
// No DOM renderer needed; we're testing wiring, not pixels (qrcode.react's
// own test suite covers the QR matrix math).

test('MemeshQr forwards the token value to QRCodeSVG verbatim', () => {
  const token = 'v1.payload.signature';
  const el = MemeshQr({ value: token });
  assert.ok(isValidElement(el));
  const props = el.props as { value: string };
  assert.equal(
    props.value,
    token,
    'token must be passed through unchanged — any rewrite would invalidate the HMAC',
  );
});

test('MemeshQr uses error-correction level M and a spec-mandated 4-module margin', () => {
  const el = MemeshQr({ value: 'v1.x.y' });
  const props = el.props as { level: string; marginSize: number };
  // Level M (15% recovery) is the documented sweet spot for the ~200-char
  // HMAC token on a phone screen — see _plans/2026-06-21-real-qr-codes.md.
  assert.equal(props.level, 'M');
  // The QR spec requires a 4-module quiet zone for finder-pattern detection.
  // Drop this and ~10% of in-the-wild scanners stop reading the symbol.
  assert.equal(props.marginSize, 4);
});

test('MemeshQr defaults to size 180 — large enough that a v10 symbol stays sharp', () => {
  const el = MemeshQr({ value: 'v1.x.y' });
  const props = el.props as { size: number };
  assert.equal(props.size, 180);
});

test('MemeshQr respects a caller-overridden size (staff view bumps to 200)', () => {
  const el = MemeshQr({ value: 'v1.x.y', size: 200 });
  const props = el.props as { size: number };
  assert.equal(props.size, 200);
});

test('MemeshQr exposes an accessible title for screen readers', () => {
  const explicit = MemeshQr({ value: 'v1.x.y', title: 'קוד QR — M-20260621-0001' });
  const explicitProps = explicit.props as { title: string };
  assert.equal(explicitProps.title, 'קוד QR — M-20260621-0001');

  const defaulted = MemeshQr({ value: 'v1.x.y' });
  const defaultedProps = defaulted.props as { title: string };
  assert.ok(
    defaultedProps.title.length > 0,
    'default title must be non-empty so the SVG is announced by screen readers',
  );
});
