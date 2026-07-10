// Guards the purchase-agnostic wording on the checkout-complete page (Yanay
// 2026-07-09): the page lands after EVERY WooCommerce purchase — entry
// tickets included — so hardcoded copy must never say "כרטיסייה" (punch
// card). The ready-state title/body come from card_settings (admin →
// Settings → דף תודה) and are Yanay's to word; only the hardcoded loading
// and failed states are pinned here.
//
// The customer app's test runner is `node --test --import tsx` with no React
// renderer, so this is a source-structure guard. Run by
// `pnpm -F @memesh/customer test`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, 'CheckoutComplete.tsx');

test('CheckoutComplete hardcodes no punch-card-specific copy', async () => {
  const src = await readFile(SOURCE, 'utf8');
  // Strip comments first — explanatory comments may name the old wording.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(
    code,
    /כרטיסייה/,
    'checkout-complete copy must stay purchase-agnostic ("הזמנה"/"רכישה") — ' +
      'a ticket buyer lands here too, and "הכרטיסייה שלך" reads wrong for them',
  );
});

test('loading and failed states speak about the order, generically', async () => {
  const src = await readFile(SOURCE, 'utf8');
  assert.match(src, /ההזמנה שלך כבר כמעט שם/, 'loading-card subtitle');
  assert.match(src, /כדי לראות את ההזמנה שלך/, 'failed-card body');
});
