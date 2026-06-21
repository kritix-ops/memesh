// Local copy of the staff-role tuple. The canonical definition lives in
// @memesh/auth, but the db package deliberately has no auth dependency (it is
// imported by both the API and standalone scripts that don't need JWTs); see
// accounts.ts for the same inline pattern. Kept in sync with staffRoleEnum
// in schema/staff.ts — if you add a role, update both files.
export const STAFF_ROLES = ['admin', 'manager', 'cashier'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// Static catalog of every capability the role-permissions system can grant.
// Single source of truth: the migration seeds defaults from here, the guard
// validates incoming keys against here, and the admin UI renders the matrix
// from here. Adding a new permission means appending an entry below, then
// shipping a follow-up migration that inserts the default rows for each role.
// Removing a permission means dropping the entry here — orphan DB rows are
// simply ignored at read time.
//
// Categories drive the UI grouping (collapsible sections in the matrix).
// Hebrew labels are the canonical display strings; English keys are stable
// machine identifiers and must never be renamed once shipped (they are
// stored in role_permissions.permission).

export type PermissionCategory =
  | 'staff'
  | 'customers'
  | 'cards'
  | 'punches'
  | 'reports'
  | 'settings'
  | 'audit';

export const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  staff: 'ניהול צוות',
  customers: 'לקוחות',
  cards: 'כרטיסיות',
  punches: 'ניקובים',
  reports: 'דוחות',
  settings: 'הגדרות',
  audit: 'יומן פעולות',
};

export interface PermissionDescriptor {
  key: string;
  category: PermissionCategory;
  label: string;
  description?: string;
  // Defaults applied at seed time. Admin is always `true` here as documentation
  // — the guard short-circuits admin to allowed regardless of the DB value.
  defaults: Record<StaffRole, boolean>;
}

const D = (admin: boolean, manager: boolean, cashier: boolean): Record<StaffRole, boolean> => ({
  admin,
  manager,
  cashier,
});

export const PERMISSIONS: PermissionDescriptor[] = [
  // ───── Staff (ניהול צוות) ─────────────────────────────────────────────
  {
    key: 'staff.view',
    category: 'staff',
    label: 'צפייה בצוות',
    description: 'הצגת רשימת אנשי הצוות.',
    defaults: D(true, true, false),
  },
  {
    key: 'staff.create',
    category: 'staff',
    label: 'הוספת איש צוות',
    description: 'יצירת חשבון חדש לאיש צוות.',
    defaults: D(true, false, false),
  },
  {
    key: 'staff.edit',
    category: 'staff',
    label: 'עריכת איש צוות',
    description: 'שינוי שם, אימייל ופרטים של איש צוות.',
    defaults: D(true, false, false),
  },
  {
    key: 'staff.delete',
    category: 'staff',
    label: 'מחיקת איש צוות',
    description: 'מחיקת חשבון איש צוות מהמערכת.',
    defaults: D(true, false, false),
  },
  {
    key: 'staff.change_role',
    category: 'staff',
    label: 'שינוי תפקיד',
    description: 'שינוי תפקיד של איש צוות (אדמין / מנהל / קופאי).',
    defaults: D(true, false, false),
  },
  {
    key: 'staff.deactivate',
    category: 'staff',
    label: 'השעיית איש צוות',
    description: 'השעיה זמנית של חשבון איש צוות מבלי למחוק אותו.',
    defaults: D(true, false, false),
  },
  {
    key: 'staff.manage_pin',
    category: 'staff',
    label: 'ניהול קוד אישי לקופאי',
    description: 'הגדרה, ייצור, איפוס ומחיקה של קוד אישי לקופאיות.',
    defaults: D(true, true, false),
  },
  {
    key: 'staff.reset_password',
    category: 'staff',
    label: 'איפוס סיסמה לאיש צוות',
    description: 'יצירת קישור איפוס סיסמה לאיש צוות אחר.',
    defaults: D(true, false, false),
  },
  {
    key: 'staff.manage_permissions',
    category: 'staff',
    label: 'ניהול הרשאות לתפקידים',
    description: 'שינוי ההרשאות המוקצות לכל תפקיד במערכת.',
    defaults: D(true, false, false),
  },

  // ───── Customers (לקוחות) ────────────────────────────────────────────
  {
    key: 'customers.view',
    category: 'customers',
    label: 'צפייה ברשימת לקוחות',
    defaults: D(true, true, true),
  },
  {
    key: 'customers.view_contact',
    category: 'customers',
    label: 'צפייה בפרטי קשר',
    description: 'הצגת מספר טלפון ואימייל של הלקוח.',
    defaults: D(true, true, true),
  },
  {
    key: 'customers.create',
    category: 'customers',
    label: 'רישום לקוח חדש',
    defaults: D(true, true, true),
  },
  {
    key: 'customers.edit',
    category: 'customers',
    label: 'עריכת לקוח',
    description: 'עדכון שם, ילדים, ערוץ תקשורת מועדף ועוד.',
    defaults: D(true, true, false),
  },
  {
    key: 'customers.delete',
    category: 'customers',
    label: 'מחיקת לקוח',
    description: 'מחיקה לצמיתות של לקוח מהמערכת (לרוב חסום בשל תלות נתונים).',
    defaults: D(true, false, false),
  },

  // ───── Cards (כרטיסיות) ──────────────────────────────────────────────
  {
    key: 'cards.view',
    category: 'cards',
    label: 'צפייה בכרטיסיות',
    defaults: D(true, true, true),
  },
  {
    key: 'cards.create',
    category: 'cards',
    label: 'מכירת כרטיסייה',
    defaults: D(true, true, true),
  },
  {
    key: 'cards.edit',
    category: 'cards',
    label: 'עריכת כרטיסייה',
    description: 'שינוי הערות ומידע נלווה לכרטיסייה קיימת.',
    defaults: D(true, true, false),
  },
  {
    key: 'cards.cancel',
    category: 'cards',
    label: 'ביטול כרטיסייה',
    defaults: D(true, true, false),
  },
  {
    key: 'cards.reassign',
    category: 'cards',
    label: 'העברת כרטיסייה ללקוח אחר',
    defaults: D(true, true, false),
  },
  {
    key: 'cards.refund_entry',
    category: 'cards',
    label: 'החזר ניקוב',
    description: 'ביטול ניקוב כניסה שנעשה בטעות.',
    defaults: D(true, true, false),
  },

  // ───── Punches (ניקובים) ─────────────────────────────────────────────
  {
    key: 'punches.create',
    category: 'punches',
    label: 'ניקוב כניסה',
    description: 'סימון כניסת לקוח לפעילות (ניקוב הכרטיסייה).',
    defaults: D(true, true, true),
  },
  {
    key: 'punches.reverse',
    category: 'punches',
    label: 'ביטול ניקוב',
    description: 'הסרת ניקוב שגוי. שונה מהחזר ניקוב — לא מחויב בכסף.',
    defaults: D(true, true, false),
  },

  // ───── Reports (דוחות) ──────────────────────────────────────────────
  {
    key: 'reports.view_basic',
    category: 'reports',
    label: 'צפייה בדוחות תפעוליים',
    description: 'נוכחות, ניקובים, פעילות יומית.',
    defaults: D(true, true, false),
  },
  {
    key: 'reports.view_financial',
    category: 'reports',
    label: 'צפייה בדוחות כספיים',
    description: 'מכירות, הכנסות, החזרים. דורש זהירות מרבית.',
    defaults: D(true, false, false),
  },
  {
    key: 'reports.export',
    category: 'reports',
    label: 'ייצוא דוחות',
    description: 'הורדת קבצי CSV / אקסל מהמערכת.',
    defaults: D(true, true, false),
  },

  // ───── Settings (הגדרות) ────────────────────────────────────────────
  {
    key: 'settings.view',
    category: 'settings',
    label: 'צפייה בהגדרות',
    defaults: D(true, false, false),
  },
  {
    key: 'settings.edit_card_settings',
    category: 'settings',
    label: 'עריכת הגדרות כרטיסייה',
    description: 'מספר ניקובים, מחיר, אורך קוד אישי וכו׳.',
    defaults: D(true, false, false),
  },
  {
    key: 'settings.edit_brand',
    category: 'settings',
    label: 'עריכת מיתוג',
    description: 'לוגו, צבעים, טקסטים שיווקיים.',
    defaults: D(true, false, false),
  },
  {
    key: 'settings.edit_integrations',
    category: 'settings',
    label: 'עריכת אינטגרציות',
    description: 'WordPress, AccuPOS, ספקים חיצוניים.',
    defaults: D(true, false, false),
  },

  // ───── Audit (יומן פעולות) ──────────────────────────────────────────
  {
    key: 'audit.view',
    category: 'audit',
    label: 'צפייה ביומן פעולות צוות',
    description: 'הצגת היסטוריית הפעולות שביצעו אנשי הצוות.',
    defaults: D(true, true, false),
  },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export const PERMISSION_KEY_SET = new Set(PERMISSION_KEYS);

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const isKnownPermission = (key: string): boolean => PERMISSION_KEY_SET.has(key);

// Used by the seed migration AND by the API list endpoint as the fallback when
// a permission was just added to the catalog but no DB row exists yet for it
// (defensive — keeps the matrix complete even before the catch-up seed runs).
export const defaultGrantFor = (role: StaffRole, key: string): boolean => {
  const descriptor = PERMISSIONS.find((p) => p.key === key);
  if (!descriptor) return false;
  return descriptor.defaults[role];
};

