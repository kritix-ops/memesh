import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves to the migrations folder co-located with this package, regardless of
// whether the package is imported from the monorepo source (packages/db/migrations)
// or from inside a deployed node_modules (node_modules/@memesh/db/migrations).
export const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
