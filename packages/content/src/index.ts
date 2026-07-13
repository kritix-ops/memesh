// Pure entry point — registry data + interpolation, no React. Imported by the
// Node API, the DB layer, and the browser apps alike. The React hook lives in
// the './react' subpath so importing the registry never pulls in React.

import { interpolate } from './interpolate';
import { contentDefaults } from './registry';

export { interpolate, placeholdersIn } from './interpolate';
export {
  CONTENT_GROUPS,
  CONTENT_REGISTRY,
  contentDefaults,
  contentEntriesByGroup,
  contentKeys,
  getContentEntry,
} from './registry';
export type { ContentEntry, ContentGroup, ContentGroupMeta, ContentKind } from './types';

/** The wire shape of GET /content: effective (override ?? default) per key. */
export type ContentMap = Record<string, string>;

/**
 * Resolve a key against a content map, with the bundled default as the fail-safe
 * fallback and the key itself as a last resort (never blank). Interpolates
 * {{vars}} when given. Shared by the React hook and server-side email copy so
 * both resolve identically.
 */
export function resolveContent(
  map: ContentMap,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const raw = map[key] ?? contentDefaults[key] ?? key;
  return vars ? interpolate(raw, vars) : raw;
}
