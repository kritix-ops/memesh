// The editable-content registry. Every entry is one admin-editable UI string:
// its stable key, Hebrew default, admin metadata, and allowed {{placeholders}}.
// Adding an editable string is a one-line addition here — no migration, since
// the DB stores only overrides keyed by these keys.
//
// Phase 1 (Wave 2 plan 2026-07-13) seeds the אזור אישי surface, starting with
// the cancellation / reschedule policy copy Yanay asked for (#3a). More
// customer strings, then the staff page, land in later phases.

import type { ContentEntry, ContentGroup, ContentGroupMeta } from './types';

export const CONTENT_GROUPS: ContentGroupMeta[] = [{ id: 'customer_area', label: 'אזור אישי' }];

export const CONTENT_REGISTRY: ContentEntry[] = [
  {
    key: 'customer.policy.cancel',
    group: 'customer_area',
    label: 'מדיניות ביטול',
    help: 'מוצג ללקוח ליד כפתור הביטול. אפשר להשתמש ב-{{hours}} כמספר השעות שמוגדר בהגדרות הסבבים.',
    default: 'אפשר לבטל הזמנה עד {{hours}} שעות לפני תחילת המועד, והזיכוי יוחזר לאמצעי התשלום.',
    kind: 'long',
    placeholders: ['hours'],
  },
  {
    key: 'customer.policy.reschedule',
    group: 'customer_area',
    label: 'מדיניות שינוי מועד',
    help: 'מוצג ללקוח ליד כפתור שינוי המועד.',
    default: 'אפשר לשנות מועד כמה פעמים שרוצים, עד שעת ההתחלה של המועד המקורי.',
    kind: 'long',
  },
  {
    key: 'customer.booking.cancelButton',
    group: 'customer_area',
    label: 'כפתור ביטול הזמנה',
    default: 'בטל הזמנה',
    kind: 'short',
  },
  {
    key: 'customer.booking.rescheduleButton',
    group: 'customer_area',
    label: 'כפתור שינוי מועד',
    default: 'שנה מועד',
    kind: 'short',
  },
  {
    key: 'customer.booking.cancelConfirmTitle',
    group: 'customer_area',
    label: 'כותרת חלון אישור ביטול',
    default: 'לבטל את ההזמנה?',
    kind: 'short',
  },
  {
    key: 'customer.nav.title',
    group: 'customer_area',
    label: 'כותרת האזור האישי',
    default: 'אזור אישי',
    kind: 'short',
  },
];

/** key → default text, for the fail-safe fallback the apps bundle. */
export const contentDefaults: Record<string, string> = Object.fromEntries(
  CONTENT_REGISTRY.map((e) => [e.key, e.default]),
);

/** Every registered key, for O(1) validation of overrides and t() calls. */
export const contentKeys: ReadonlySet<string> = new Set(CONTENT_REGISTRY.map((e) => e.key));

const byKey: Map<string, ContentEntry> = new Map(CONTENT_REGISTRY.map((e) => [e.key, e]));

export function getContentEntry(key: string): ContentEntry | undefined {
  return byKey.get(key);
}

/** Entries in a group, in registry order — drives the grouped admin editor. */
export function contentEntriesByGroup(group: ContentGroup): ContentEntry[] {
  return CONTENT_REGISTRY.filter((e) => e.group === group);
}
