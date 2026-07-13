// Pure entry point — registry data + interpolation, no React. Imported by the
// Node API, the DB layer, and the browser apps alike. The React hook lives in
// the './react' subpath so importing the registry never pulls in React.

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
