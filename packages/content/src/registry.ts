// The editable-content registry. Every entry is one admin-editable UI string:
// its stable key, Hebrew default, admin metadata, and allowed {{placeholders}}.
// Adding an editable string is a one-line addition here — no migration, since
// the DB stores only overrides keyed by these keys.
//
// Wave 2 plan 2026-07-13. Extracted surface by surface from the apps; the
// אזור אישי (customer area) comes first. Keys are stable forever — never rename
// or reuse one (the DB overrides + every t() call site depend on it).

import type { ContentEntry, ContentGroup, ContentGroupMeta } from './types';

export const CONTENT_GROUPS: ContentGroupMeta[] = [
  { id: 'customer_general', label: 'אזור אישי — כללי' },
  { id: 'customer_booking', label: 'אזור אישי — ניהול הזמנה' },
];

export const CONTENT_REGISTRY: ContentEntry[] = [
  // ── אזור אישי — כללי ──────────────────────────────────────────────
  {
    key: 'customer.nav.title',
    group: 'customer_general',
    label: 'כותרת האזור האישי',
    default: 'אזור אישי',
    kind: 'short',
  },

  // ── אזור אישי — ניהול הזמנה (RoundBookingCard) ────────────────────
  // Policy copy Yanay asked for (#3a). The cancel policy uses {{hours}}; its
  // live render is wired once the configured window value reaches the app.
  {
    key: 'customer.policy.cancel',
    group: 'customer_booking',
    label: 'מדיניות ביטול',
    help: 'אפשר להשתמש ב-{{hours}} כמספר השעות שמוגדר בהגדרות הסבבים.',
    default: 'אפשר לבטל הזמנה עד {{hours}} שעות לפני תחילת המועד, והזיכוי יוחזר לאמצעי התשלום.',
    kind: 'long',
    placeholders: ['hours'],
  },
  {
    key: 'customer.policy.reschedule',
    group: 'customer_booking',
    label: 'מדיניות שינוי מועד',
    default: 'אפשר לשנות מועד עד שעת ההתחלה של ההזמנה המקורית.',
    kind: 'long',
  },
  {
    key: 'customer.booking.rescheduleButton',
    group: 'customer_booking',
    label: 'כפתור שינוי מועד',
    default: 'שנה מועד',
    kind: 'short',
  },
  {
    key: 'customer.booking.cancelButton',
    group: 'customer_booking',
    label: 'כפתור ביטול הזמנה',
    default: 'בטל הזמנה',
    kind: 'short',
  },
  {
    key: 'customer.booking.backButton',
    group: 'customer_booking',
    label: 'כפתור חזרה',
    default: 'חזרה',
    kind: 'short',
  },
  {
    key: 'customer.booking.ticketBaby',
    group: 'customer_booking',
    label: 'תווית כרטיס תינוק',
    default: 'תינוק/ת',
    kind: 'short',
  },
  {
    key: 'customer.booking.ticketChild',
    group: 'customer_booking',
    label: 'תווית כרטיס ילד',
    default: 'ילד/ה',
    kind: 'short',
  },
  {
    key: 'customer.booking.withCompanion',
    group: 'customer_booking',
    label: 'תווית מלווה נוסף',
    default: 'כולל מלווה נוסף',
    kind: 'short',
  },
  {
    key: 'customer.booking.used',
    group: 'customer_booking',
    label: 'תווית הזמנה שנוצלה',
    default: 'נוצל',
    kind: 'short',
  },
  {
    key: 'customer.booking.qrTitle',
    group: 'customer_booking',
    label: 'כותרת הברקוד',
    help: '{{label}} הוא שם הסבב.',
    default: 'ברקוד — {{label}}',
    kind: 'short',
    placeholders: ['label'],
  },
  {
    key: 'customer.booking.punchcardNote',
    group: 'customer_booking',
    label: 'הערת ניצול כניסה מהכרטיסייה',
    default:
      'כניסה אחת כבר נוצלה מהכרטיסייה עבור ההזמנה הזו והיא שמורה לך לתאריך זה. שימו לב לא לנצל את כל הכניסות לפני כן.',
    kind: 'long',
  },
  {
    key: 'customer.booking.companionPending',
    group: 'customer_booking',
    label: 'תווית מלווה ממתין לתשלום',
    default: 'מלווה נוסף — ממתין לתשלום',
    kind: 'short',
  },
  {
    key: 'customer.booking.companionPayButton',
    group: 'customer_booking',
    label: 'כפתור השלמת תשלום מלווה',
    default: 'השלמת תשלום',
    kind: 'short',
  },
  {
    key: 'customer.booking.companionPayError',
    group: 'customer_booking',
    label: 'שגיאת פתיחת תשלום מלווה',
    default: 'לא ניתן לפתוח את התשלום כרגע. נסו שוב.',
    kind: 'long',
  },
  {
    key: 'customer.booking.cancelConfirmTitle',
    group: 'customer_booking',
    label: 'כותרת אישור ביטול',
    default: 'לבטל את ההזמנה?',
    kind: 'short',
  },
  {
    key: 'customer.booking.cancelRefundPunchCompanion',
    group: 'customer_booking',
    label: 'הסבר ביטול — כרטיסייה + מלווה',
    default: 'הכניסה תוחזר לכרטיסייה שלך, והתשלום עבור המלווה הנוסף יוחזר אוטומטית.',
    kind: 'long',
  },
  {
    key: 'customer.booking.cancelRefundPunch',
    group: 'customer_booking',
    label: 'הסבר ביטול — כרטיסייה',
    default: 'הכניסה תוחזר לכרטיסייה שלך.',
    kind: 'long',
  },
  {
    key: 'customer.booking.cancelRefundPaid',
    group: 'customer_booking',
    label: 'הסבר ביטול — תשלום',
    default: 'הזיכוי יוחזר אוטומטית לאמצעי התשלום שלכם.',
    kind: 'long',
  },
  {
    key: 'customer.booking.cancelConfirmButton',
    group: 'customer_booking',
    label: 'כפתור אישור ביטול',
    default: 'כן, בטלו וזכו אותי',
    kind: 'short',
  },
  {
    key: 'customer.booking.cancelErrorTooLate',
    group: 'customer_booking',
    label: 'שגיאת ביטול — מאוחר מדי',
    default: 'כבר מאוחר מדי לבטל (אפשר עד 24 שעות לפני הסבב).',
    kind: 'long',
  },
  {
    key: 'customer.booking.cancelErrorRefundFailed',
    group: 'customer_booking',
    label: 'שגיאת ביטול — זיכוי נכשל',
    default: 'הזיכוי לא הושלם. נסו שוב או פנו אלינו.',
    kind: 'long',
  },
  {
    key: 'customer.booking.cancelErrorGeneric',
    group: 'customer_booking',
    label: 'שגיאת ביטול — כללית',
    default: 'לא ניתן לבטל כרגע. נסו שוב.',
    kind: 'long',
  },
  {
    key: 'customer.booking.swapErrorFull',
    group: 'customer_booking',
    label: 'שגיאת שינוי מועד — סבב מלא',
    default: 'הסבב התמלא. בחרו מועד אחר.',
    kind: 'long',
  },
  {
    key: 'customer.booking.swapErrorTooLate',
    group: 'customer_booking',
    label: 'שגיאת שינוי מועד — מאוחר מדי',
    default: 'כבר מאוחר מדי לשנות — אפשר עד שעת ההתחלה של ההזמנה המקורית.',
    kind: 'long',
  },
  {
    key: 'customer.booking.swapErrorGeneric',
    group: 'customer_booking',
    label: 'שגיאת שינוי מועד — כללית',
    default: 'לא ניתן לשנות כרגע. נסו שוב.',
    kind: 'long',
  },
  {
    key: 'customer.booking.pickerTitle',
    group: 'customer_booking',
    label: 'כותרת בחירת מועד',
    default: 'בחרו מועד אחר — שעה אחרת או יום אחר',
    kind: 'short',
  },
  {
    key: 'customer.booking.availabilityError',
    group: 'customer_booking',
    label: 'שגיאת טעינת זמינות',
    default: 'לא ניתן לטעון זמינות כרגע. נסו לרענן את הדף.',
    kind: 'long',
  },
  {
    key: 'customer.booking.pickerOwnDateBadge',
    group: 'customer_booking',
    label: 'סימון תאריך ההזמנה בבחירה',
    default: '(התאריך של ההזמנה)',
    kind: 'short',
  },
  {
    key: 'customer.booking.pickerEmptyClosed',
    group: 'customer_booking',
    label: 'אין מועדים — המקום סגור',
    default: 'המקום סגור בתאריך זה — בחרו יום אחר.',
    kind: 'long',
  },
  {
    key: 'customer.booking.pickerEmptyFreePlay',
    group: 'customer_booking',
    label: 'אין מועדים — כניסה חופשית',
    default: 'בתאריך זה הכניסה חופשית — אין סבבים להזמנה.',
    kind: 'long',
  },
  {
    key: 'customer.booking.pickerEmptySameDay',
    group: 'customer_booking',
    label: 'אין מועדים — אותו יום',
    default: 'אין סבב אחר פנוי ביום זה — אפשר לבחור יום אחר מהפס למעלה.',
    kind: 'long',
  },
  {
    key: 'customer.booking.pickerEmptyOtherDay',
    group: 'customer_booking',
    label: 'אין מועדים — יום אחר',
    default: 'אין סבבים פנויים ביום זה — בחרו יום אחר.',
    kind: 'long',
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
