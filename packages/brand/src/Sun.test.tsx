import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement } from 'react';
import { Sun } from './brand';

// The Sun mark is rendered straight from the source PNG (logo/sun.png)
// rather than a synthesized SVG, so the hand-drawn rays and ring stay
// pixel-faithful at every size. These tests guard the wiring: that we
// emit an <img>, hand the asset URL to its src, and honour the size/spin
// props the loading shells depend on. No DOM renderer needed — we
// inspect the returned React element directly, matching MemeshQr.test.

test('Sun renders the brand-mark PNG via an <img>, not a synthesized SVG', () => {
  const el = Sun({});
  assert.ok(isValidElement(el));
  assert.equal(el.type, 'img', 'Sun must render the PNG asset, not an inline <svg>');
  const props = el.props as { src: string };
  assert.ok(props.src.length > 0, 'src must be the bundler-resolved asset URL');
});

test('Sun carries the brand name as its accessible label', () => {
  const el = Sun({});
  const props = el.props as { alt: string };
  // The mark is the brand; screen readers should announce it as "ממש".
  // Loading shells pair it with "טוען…" so the combined announcement is
  // intelligible without being noisy.
  assert.equal(props.alt, 'ממש');
});

test('Sun defaults to 46px and honours an explicit size', () => {
  const def = Sun({}) as { props: { width: number; height: number } };
  assert.equal(def.props.width, 46);
  assert.equal(def.props.height, 46);

  const custom = Sun({ size: 64 }) as { props: { width: number; height: number } };
  assert.equal(custom.props.width, 64);
  assert.equal(custom.props.height, 64);
});

test('Sun wires the memesh-spin keyframes only when spin is true', () => {
  const still = Sun({}) as { props: { style: { animation?: string } } };
  assert.equal(
    still.props.style.animation,
    undefined,
    'a still Sun must not spin — the keyframes belong to loading states only',
  );

  const spinning = Sun({ spin: true }) as { props: { style: { animation?: string } } };
  assert.equal(
    spinning.props.style.animation,
    'memesh-spin 6s linear infinite',
    'spin must use the shared memesh-spin keyframes defined in each app index.css',
  );
});
