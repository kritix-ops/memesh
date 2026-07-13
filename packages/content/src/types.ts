// Types for the editable-content registry — the single source of truth for
// every admin-editable UI string. Pure types + data live in this package with
// no React and no Node/browser APIs, so the API, the DB layer, and all three
// browser apps import the exact same registry (Wave 2 plan 2026-07-13).

/** Which input the admin editor renders, and the length band on save. */
export type ContentKind = 'short' | 'long';

/** Admin grouping bucket. Grows one entry per migrated surface. */
export type ContentGroup =
  | 'customer_general'
  | 'customer_login'
  | 'customer_bookings'
  | 'customer_booking'
  | 'customer_bookflow'
  | 'customer_picker'
  | 'customer_cards'
  | 'customer_profile'
  | 'customer_waitlist';

export interface ContentGroupMeta {
  id: ContentGroup;
  /** Section heading in the admin editor (Hebrew). */
  label: string;
}

export interface ContentEntry {
  /**
   * Stable unique id, e.g. 'customer.cancel.rule'. This is the contract with the
   * DB overrides and every t() call site — never rename or reuse a key.
   */
  key: string;
  group: ContentGroup;
  /** Field label in the admin editor (Hebrew). */
  label: string;
  /** Optional helper text under the field (Hebrew). */
  help?: string;
  /**
   * The fallback text, always non-empty. The app renders this whenever there's
   * no override — so a blank/reset field or a dead /content endpoint can never
   * show an empty label.
   */
  default: string;
  kind: ContentKind;
  /**
   * Placeholder names allowed inside {{...}} in the value. Validated on save and
   * cross-checked against the default by the registry integrity test.
   */
  placeholders?: string[];
}
