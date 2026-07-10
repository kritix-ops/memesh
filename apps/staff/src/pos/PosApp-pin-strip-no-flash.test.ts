// Guards the fix for the Home PIN-strip flash (Yanay 2026-07-09): the two
// cashier-PIN buttons ("החלף קופאי" / "ניהול הקוד שלי") used to render from
// the fail-closed FALLBACK_SELL_CONTROLS (requireSellerPin: true) the moment
// the page mounted, then vanish when getPosSellControls() resolved false for
// the venue. Home must only see requireSellerPin=true AFTER the fetch settles.
//
// The staff app's test runner is `node --test --import tsx` with no React
// renderer wired, so these are source-structure guards in the style of
// PosApp-no-inner-components.test.ts: they pin the load gate in the source
// so a refactor can't quietly reintroduce the flash. Run by
// `pnpm -F @memesh/staff test`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POS_APP = resolve(HERE, 'PosApp.tsx');

test('Home receives requireSellerPin gated on the sell-controls load', async () => {
  const src = await readFile(POS_APP, 'utf8');
  assert.match(
    src,
    /requireSellerPin=\{sellControlsLoaded && sellControls\.requireSellerPin\}/,
    'Home must not see requireSellerPin=true before getPosSellControls() settles — ' +
      'passing sellControls.requireSellerPin directly re-creates the button flash.',
  );
});

test('sellControlsLoaded flips true after the fetch settles, on both outcomes', async () => {
  const src = await readFile(POS_APP, 'utf8');
  assert.match(
    src,
    /const \[sellControlsLoaded, setSellControlsLoaded\] = useState\(false\)/,
    'the load gate must start false (nothing renders from the fallback)',
  );
  // setSellControlsLoaded(true) must sit AFTER the s.ok/else block, outside
  // any condition, so a fetch error still reveals the (fail-closed) strip.
  const settle = src.indexOf('setSellControlsLoaded(true)');
  assert.notStrictEqual(settle, -1, 'the fetch effect must settle the load gate');
  const fallbackLog = src.indexOf("'[web pos sell-controls] fallback (fail-closed)'");
  assert.notStrictEqual(fallbackLog, -1, 'expected the fail-closed fallback branch');
  assert.ok(
    settle > fallbackLog,
    'setSellControlsLoaded(true) must run after both the ok and the fallback branches, ' +
      'so an API error still shows the strip (fail-closed) instead of hiding it forever',
  );
});
