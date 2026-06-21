// Guards against the React anti-pattern that caused the staff POS to feel
// laggy on every keystroke: declaring child components inside the PosApp
// function body. When inner functions like `function Search() {}` live in
// PosApp's closure, every parent re-render creates a new function reference,
// React unmounts the entire subtree, and any <input> the subtree contains
// loses focus mid-typing. See _plans/2026-06-22-staff-pos-refactor-fix-typing-lag.md.
//
// This test reads the raw source file and asserts no function/component
// declarations sit between `export function PosApp() {` and its matching
// closing brace. Run by `pnpm -F @memesh/staff test`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POS_APP = resolve(HERE, 'PosApp.tsx');

const findPosAppBody = (src: string): string => {
  const startMarker = 'export function PosApp() {';
  const startIdx = src.indexOf(startMarker);
  assert.notStrictEqual(startIdx, -1, 'expected to find `export function PosApp() {`');
  // Walk braces from the opening { until the matching close.
  const openBraceIdx = startIdx + startMarker.length - 1;
  let depth = 0;
  let i = openBraceIdx;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < src.length; i += 1) {
    const c = src[i]!;
    const next = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openBraceIdx + 1, i);
    }
  }
  assert.fail('reached end of file before PosApp closing brace');
};

test('PosApp body declares no inner component/function (anti-pattern guard)', async () => {
  const src = await readFile(POS_APP, 'utf8');
  const body = findPosAppBody(src);
  // Two-space indent is the file's convention. Any `function X(` at this
  // indent inside PosApp would be the regression we are guarding against.
  // We allow no nested arrow components or function declarations whatsoever:
  // the screens live at module scope. Helper closures that take values (not
  // returning JSX) are also out — keep PosApp a pure orchestrator.
  const declRe = /(^|\n)  function [A-Za-z_$][A-Za-z0-9_$]*\(/g;
  const matches = [...body.matchAll(declRe)].map((m) => m[0].trim());
  assert.deepStrictEqual(
    matches,
    [],
    `Found inner function declarations inside PosApp — lift them to module scope:\n${matches.join('\n')}`,
  );
});

test('PosApp imports do not lift back into the body (sanity)', async () => {
  // Catches the related mistake: someone moves a screen back inside PosApp
  // and uses a different indent. We check for any `function Foo(`, `const Foo
  // = (`, or `const Foo: ` declaration inside PosApp's body, regardless of
  // indent. Adjust the allowlist if a deliberately-inner helper lands.
  const src = await readFile(POS_APP, 'utf8');
  const body = findPosAppBody(src);
  const broadRe = /\bfunction\s+[A-Z][A-Za-z0-9_$]*\s*\(/g;
  const matches = [...body.matchAll(broadRe)].map((m) => m[0]);
  assert.deepStrictEqual(
    matches,
    [],
    `Found a capitalized inner function (likely a component) inside PosApp:\n${matches.join('\n')}`,
  );
});
