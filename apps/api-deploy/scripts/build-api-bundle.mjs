// Bundles the Fastify app (apps/api/src/app.ts) and ALL its workspace deps
// into a single ESM file at apps/api-deploy/lib/api-bundle.mjs. The Vercel
// serverless function at apps/api-deploy/api/server.ts imports from this
// bundle. Without this step, Vercel's @vercel/node runtime leaves workspace
// imports as externals (treating them as node_modules), and at runtime Node
// ESM fails to load the .ts source files that workspace symlinks point at.
//
// Twin of apps/web/scripts/build-api-bundle.mjs. The web copy goes away once
// Phase 5 deletes apps/web and api.memesh.co.il becomes the only API origin.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const deployRoot = resolve(here, '..');
const repoRoot = resolve(deployRoot, '..', '..');

const entry = resolve(repoRoot, 'apps/api/src/app.ts');
const outfile = resolve(deployRoot, 'lib/api-bundle.mjs');

console.info('[build api] entry', entry);
console.info('[build api] outfile', outfile);

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  // Bundle EVERYTHING including node_modules so the function ships with all
  // its transitive deps inlined. pg and other deps with CJS internals are
  // handled by the banner below.
  packages: 'bundle',
  // pino-pretty is dev-only (used when NODE_ENV=development). It pulls in a
  // lot of code we never need in production, and esbuild fails to resolve
  // some of its sub-deps under bundle mode. Marking it external means it
  // only loads if someone explicitly requires it at runtime, which in prod
  // they won't.
  external: ['pino-pretty'],
  // Some deps still use CJS-style require() (e.g. drizzle, pg internals).
  // Inject a shim that makes require() available inside the ESM bundle.
  banner: {
    js: [
      "import { createRequire as __memeshCreateRequire } from 'node:module';",
      "import { fileURLToPath as __memeshFileURLToPath } from 'node:url';",
      "import { dirname as __memeshDirname } from 'node:path';",
      'const require = __memeshCreateRequire(import.meta.url);',
      'const __filename = __memeshFileURLToPath(import.meta.url);',
      'const __dirname = __memeshDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
  sourcemap: false,
  minify: false,
});

console.info('[build api] done');
