// Walks the relative-import graph starting at src/App.tsx and asserts the
// other two surfaces (AdminApp, CustomerApp) are NOT reachable. The single
// highest-cost mistake in the split is accidentally re-importing the wrong
// surface — this test catches it before it ships.

import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveSpec = async (spec: string, fromDir: string): Promise<string | null> => {
  const base = resolve(fromDir, spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return null;
};

const collectImports = async (
  entry: string,
  visited: Set<string> = new Set(),
): Promise<Set<string>> => {
  if (visited.has(entry)) return visited;
  visited.add(entry);
  const content = await readFile(entry, 'utf8');
  for (const match of content.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec) continue;
    if (!spec.startsWith('.')) continue; // skip @packages / node:
    const resolved = await resolveSpec(spec, dirname(entry));
    if (resolved) await collectImports(resolved, visited);
  }
  return visited;
};

test('apps/staff transitive imports never reach AdminApp', async () => {
  const graph = await collectImports(resolve(HERE, 'App.tsx'));
  for (const file of graph) {
    assert.ok(!file.endsWith('AdminApp.tsx'), `forbidden surface AdminApp reached via ${file}`);
  }
});

test('apps/staff transitive imports never reach CustomerApp', async () => {
  const graph = await collectImports(resolve(HERE, 'App.tsx'));
  for (const file of graph) {
    assert.ok(
      !file.endsWith('CustomerApp.tsx'),
      `forbidden surface CustomerApp reached via ${file}`,
    );
  }
});

test('positive control: walker actually reaches PosApp.tsx', async () => {
  // Without this control the two assertions above would pass vacuously if the
  // walker were broken (returned an empty set).
  const graph = await collectImports(resolve(HERE, 'App.tsx'));
  const reached = [...graph].some((f) => f.endsWith('PosApp.tsx'));
  assert.ok(reached, 'walker did not reach PosApp.tsx — the negative assertions are vacuous');
});
