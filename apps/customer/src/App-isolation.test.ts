// Walks the relative-import graph starting at src/App.tsx and asserts the
// other two surfaces (PosApp, AdminApp) are NOT reachable.

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
    if (!spec.startsWith('.')) continue;
    const resolved = await resolveSpec(spec, dirname(entry));
    if (resolved) await collectImports(resolved, visited);
  }
  return visited;
};

test('apps/customer transitive imports never reach PosApp', async () => {
  const graph = await collectImports(resolve(HERE, 'App.tsx'));
  for (const file of graph) {
    assert.ok(!file.endsWith('PosApp.tsx'), `forbidden surface PosApp reached via ${file}`);
  }
});

test('apps/customer transitive imports never reach AdminApp', async () => {
  const graph = await collectImports(resolve(HERE, 'App.tsx'));
  for (const file of graph) {
    assert.ok(!file.endsWith('AdminApp.tsx'), `forbidden surface AdminApp reached via ${file}`);
  }
});

test('positive control: walker actually reaches CustomerApp.tsx', async () => {
  const graph = await collectImports(resolve(HERE, 'App.tsx'));
  const reached = [...graph].some((f) => f.endsWith('CustomerApp.tsx'));
  assert.ok(reached, 'walker did not reach CustomerApp.tsx — the negative assertions are vacuous');
});
