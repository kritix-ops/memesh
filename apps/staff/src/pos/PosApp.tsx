import { MemeshQr, PunchCard, Sun } from '@memesh/brand';
import { useStaffSession } from '@memesh/staff-auth';
import { fmtDate } from '@memesh/web-shared';
import { Scanner, type IDetectedBarcode, type IScannerError } from '@yudiel/react-qr-scanner';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import {
  getCardPricing,
  getCustomerFormRules,
  getPosSellControls,
  type CardPricing,
  type CustomerFormRules,
  type PosSellControls,
} from '../lib/api/card-settings';
import { refundEntry, sellCard, type SellCardResponse } from '../lib/api/cards';
import {
  createCustomer,
  getCustomerDetail,
  searchCustomers,
  type ChildRecord,
  type Customer,
  type CustomerDetailResponse,
  type CustomerSourceValue,
  type PunchCard as ApiPunchCard,
} from '../lib/api/customers';
import {
  debugVerifyToken,
  lookupBySerial,
  lookupByToken,
  punchBySerial,
  punchByToken,
  type ScanLookupResponse,
} from '../lib/api/punch';
import { getMyPinStatus, setMyPin } from '../lib/api/staff';
import { entriesLabel } from '../mock';
import { PunchConfirmModal } from './PunchConfirmModal';
import { RefundEntryModal } from './RefundEntryModal';

const ORANGE = '#ffa983';
const INK = '#2d3436';
const MUTED = '#636e72';
const SHADOW = '0 4px 20px rgba(0,0,0,0.08)';

const card: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 20,
};

const primaryBtn: CSSProperties = {
  background: ORANGE,
  color: '#fff',
  border: 'none',
  borderRadius: 10,
  fontWeight: 600,
  padding: '14px 28px',
  fontSize: 16,
  cursor: 'pointer',
};

const ghostBtn: CSSProperties = {
  background: '#fff',
  color: MUTED,
  border: '1.5px solid #e9e0d9',
  borderRadius: 10,
  fontWeight: 600,
  padding: '14px 28px',
  fontSize: 16,
  cursor: 'pointer',
};

const inputStyle: CSSProperties = {
  width: '100%',
  fontSize: 17,
  padding: '14px 16px',
  border: '1.5px solid #e9e0d9',
  borderRadius: 12,
  background: '#fff',
  outline: 'none',
};

// Returns a time-of-day greeting in Hebrew. The cashier sees this on the POS
// home; we drop the previously hardcoded name until /auth/me carries the staff
// profile in a follow-up.
function greetingFor(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'בוקר טוב';
  if (h >= 12 && h < 17) return 'צהריים טובים';
  if (h >= 17 && h < 21) return 'ערב טוב';
  return 'לילה טוב';
}

// "יום שלישי · 17 ביוני 2026" using Intl with the he-IL locale.
function hebrewDate(now: Date): string {
  const fmt = new Intl.DateTimeFormat('he-IL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  return `${weekday} · ${day} ${month} ${year}`;
}

// Helpers for the REAL Customer shape from /customers (firstName/lastName/etc).
// MockCustomer's helpers in ../mock take a different shape (.first/.last) and
// still serve the Scan/Sell mock flows; these only handle the live data.
const AVATARS = [
  { bg: '#fff4ee', color: '#ffa983' },
  { bg: '#f3f7e8', color: '#8fae4f' },
  { bg: '#fdeee6', color: '#d98b62' },
  { bg: '#eef3e2', color: '#7fa043' },
];
const realFullName = (c: Pick<Customer, 'firstName' | 'lastName'>): string =>
  `${c.firstName} ${c.lastName}`;
const realInitials = (c: Pick<Customer, 'firstName' | 'lastName'>): string =>
  (c.firstName[0] ?? '') + (c.lastName[0] ?? '');
const realAvatar = (id: string) => {
  const last = id[id.length - 1] ?? '0';
  const i = (Number.parseInt(last, 16) || 0) % AVATARS.length;
  return AVATARS[i] ?? AVATARS[0]!;
};

// Pick the card to show on a customer's detail screen: prefer the active one,
// otherwise the most recent. cards arrive sorted by createdAt desc from the API.
const pickActiveCard = (cards: ApiPunchCard[]): ApiPunchCard | undefined =>
  cards.find((c) => c.isActive) ?? cards[0];

const yyyyMmDd = (iso: string): string => iso.slice(0, 10);
const hhMm = (iso: string): string => {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

const SEARCH_DEBOUNCE_MS = 250;

// Server returns short reason codes from POST /punch (see apps/api/src/routes/punch.ts).
// Map them to messages the cashier can act on.
function humanizePunchError(code: string): string {
  if (code === 'exhausted') return 'הכרטיסייה מנוצלת — אין כניסות נוספות.';
  if (code === 'expired') return 'הכרטיסייה פגת תוקף.';
  if (code === 'inactive') return 'הכרטיסייה אינה פעילה.';
  if (code === 'not_found') return 'הכרטיסייה לא נמצאה. נסו שוב.';
  if (code === 'invalid_signature') return 'קוד QR לא תקין. השתמשו במספר סידורי.';
  if (code === 'invalid_body') return 'נתוני הניקוב לא תקינים.';
  return 'שגיאה בניקוב. נסו שוב בעוד רגע.';
}

function humanizeSellError(code: string): string {
  if (code === 'invalid_body') return 'נתונים לא תקינים. בדקו ונסו שוב.';
  if (code === 'receipt_number_required') return 'יש להזין את מספר הקבלה לפני המכירה.';
  if (code === 'receipt_number_duplicate')
    return 'מספר הקבלה הזה כבר משויך לכרטיסייה אחרת. בדקו את הקבלה.';
  if (code === 'pin_required') return 'יש להזין את הקוד האישי לפני המכירה.';
  if (code === 'pin_not_set') return 'לא הוגדר קוד אישי לחשבון שלך. פנה למנהל.';
  if (code === 'invalid_pin') return 'הקוד שגוי. נסה שוב.';
  if (code === 'pin_locked' || code === 'pin_locked_now')
    return 'הקוד ננעל לאחר ניסיונות שגויים. פנה למנהל לשחרור.';
  return 'שגיאה במכירת הכרטיסייה. נסו שוב.';
}

function humanizeRefundError(code: string): string {
  if (code === 'admin_password_required') return 'נדרשת סיסמת אדמין.';
  if (code === 'admin_password_invalid')
    return 'סיסמת אדמין שגויה. ודאו שמדובר באדמין פעיל ונסו שוב.';
  if (code === 'entry_not_found') return 'הכניסה לא נמצאה. ייתכן שכבר הוחזרה.';
  if (code === 'already_refunded') return 'הכניסה כבר הוחזרה.';
  if (code === 'card_cancelled')
    return 'לא ניתן להחזיר כניסות בכרטיסייה מבוטלת.';
  if (code === 'invalid_body') return 'נתונים לא תקינים. בדקו ונסו שוב.';
  if (code === 'forbidden') return 'אין לך הרשאה לבצע החזר.';
  return 'תקלה זמנית. נסו שוב בעוד רגע.';
}

// Maps @yudiel/react-qr-scanner's IScannerError.kind to Hebrew. Order matches
// the typed union so a future addition surfaces as 'unknown' instead of slipping.
function humanizeScanError(kind: IScannerError['kind']): string {
  if (kind === 'permission-denied')
    return 'אין הרשאה למצלמה. אפשרו מצלמה בהגדרות הדפדפן או השתמשו בהזנת מספר סידורי.';
  if (kind === 'no-camera') return 'לא נמצאה מצלמה בהתקן. השתמשו בהזנת מספר סידורי.';
  if (kind === 'in-use') return 'המצלמה בשימוש ביישום אחר. סגרו וחזרו לסרוק.';
  if (kind === 'insecure-context')
    return 'הסריקה דורשת חיבור מאובטח (HTTPS). השתמשו בהזנת מספר סידורי.';
  if (kind === 'unsupported') return 'הדפדפן לא תומך בסריקה. השתמשו בהזנת מספר סידורי.';
  return 'שגיאה זמנית במצלמה. נסו שוב או הזינו מספר סידורי.';
}

type Screen = 'home' | 'search' | 'customer' | 'new' | 'sell' | 'scan';
type SellStep = 'choose' | 'confirm' | 'done';

// Fallback if /pos/card-pricing fails (network blip, brief API outage). The
// sale must still go through — the server uses its own settings on POST /cards,
// so a stale fallback here only affects what the cashier sees, not what's charged.
const FALLBACK_PRICING: CardPricing = {
  priceShekels: 320,
  pitchLabel: 'משלמים על 10, מקבלים 12 · תקף לשנה',
};
const FALLBACK_FORM_RULES: CustomerFormRules = { requireEmail: false, requireChild: false };
// Fail-closed defaults for the sell-flow controls: assume the anti-fraud
// requirements are ON if the API call fails, so a transient failure doesn't
// silently bypass receipt + PIN enforcement at the till. The server still
// re-validates on POST /cards; this fallback only governs what the UI shows.
const FALLBACK_SELL_CONTROLS: PosSellControls = {
  requireReceiptNumberOnPos: true,
  requireSellerPin: true,
  pinLength: 3,
  pinMemoryMinutes: 15,
  nameOnReceiptLabel: 'רשמתי את שם הלקוח על הקבלה במעמד התשלום',
  emailNudgeText:
    'האימייל לא חובה אך מומלץ — מאפשר ללקוח להיכנס לאזור האישי גם אם החליף מספר טלפון או אם ה-SMS לא יגיע.',
};

// Module-scoped PIN session memory. Lives only in the running tab — never
// persisted to localStorage/sessionStorage so a closed tab loses it. Keyed
// by staffId so two-cashier-per-shift setups work without confusion. The
// expiry is set when the PIN is first remembered and slides forward on each
// successful sale (see useSellerPinMemory).
interface CachedPin {
  pin: string;
  /** Wall-clock ms when this cached PIN goes stale. */
  expiresAt: number;
}
const sellerPinCache = new Map<string, CachedPin>();

function readCachedPin(staffId: string, now: number = Date.now()): string | null {
  const entry = sellerPinCache.get(staffId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    sellerPinCache.delete(staffId);
    return null;
  }
  return entry.pin;
}

function writeCachedPin(staffId: string, pin: string, memoryMinutes: number): void {
  sellerPinCache.set(staffId, {
    pin,
    expiresAt: Date.now() + memoryMinutes * 60 * 1000,
  });
}

function clearCachedPin(staffId: string): void {
  sellerPinCache.delete(staffId);
}

export function PosApp() {
  const { state: sessionState } = useStaffSession();
  // The session is guaranteed signed-in here (App.tsx gates this surface), but
  // the discriminated union still needs narrowing for type safety.
  const sessionUser = sessionState.status === 'signed-in' ? sessionState.user : null;

  const [screen, setScreen] = useState<Screen>('home');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sellStep, setSellStep] = useState<SellStep>('choose');

  // Card price + pitch text + customer-form rules + sell controls all come
  // from /pos/* endpoints (admin-editable in 'הגדרות'). Fetched together on
  // mount; each independently falls back to hardcoded defaults if its call
  // fails so the cashier is never blocked from working. The entries-per-scan
  // picker is no longer settings-driven — the cashier picks at the till,
  // bounded by the card's remaining entries.
  const [pricing, setPricing] = useState<CardPricing>(FALLBACK_PRICING);
  const [formRules, setFormRules] = useState<CustomerFormRules>(FALLBACK_FORM_RULES);
  const [sellControls, setSellControls] = useState<PosSellControls>(FALLBACK_SELL_CONTROLS);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, r, s] = await Promise.all([
        getCardPricing(),
        getCustomerFormRules(),
        getPosSellControls(),
      ]);
      if (cancelled) return;
      if (p.ok) {
        console.info('[web pos pricing] fetched', { priceShekels: p.data.priceShekels });
        setPricing(p.data);
      } else {
        console.warn('[web pos pricing] fallback', { error: p.error });
      }
      if (r.ok) {
        console.info('[web pos form-rules] fetched', r.data);
        setFormRules(r.data);
      } else {
        console.warn('[web pos form-rules] fallback', { error: r.error });
      }
      if (s.ok) {
        console.info('[web pos sell-controls] fetched', {
          requireReceipt: s.data.requireReceiptNumberOnPos,
          requirePin: s.data.requireSellerPin,
          pinLength: s.data.pinLength,
        });
        setSellControls(s.data);
      } else {
        console.warn('[web pos sell-controls] fallback (fail-closed)', { error: s.error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sell-flow extras: receipt number + name-on-receipt affirmation + the
  // pending-PIN modal. Reset whenever the customer changes or after a sale
  // completes (so the next sale starts from a clean slate, never reusing
  // the previous receipt number by accident).
  const [receiptNumber, setReceiptNumber] = useState('');
  const [nameOnReceiptChecked, setNameOnReceiptChecked] = useState(false);
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [selfPinModalOpen, setSelfPinModalOpen] = useState(false);
  useEffect(() => {
    if (sellStep === 'choose' || sellStep === 'done') {
      setReceiptNumber('');
      setNameOnReceiptChecked(false);
    }
  }, [selectedId, sellStep]);

  // Live search state (debounced + abortable). Empty query => no fetch.
  const [searchResults, setSearchResults] = useState<Customer[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Live customer detail state. Fetched when selectedId changes.
  const [detail, setDetail] = useState<CustomerDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Punch flow state. punchKey is generated once per modal open so a
  // double-click or network retry replays on the server (no double punch).
  // punchStatus holds an inline success or error message under the punch
  // button; it auto-clears after a couple seconds.
  const [askPunch, setAskPunch] = useState(false);
  const [punching, setPunching] = useState(false);
  const [punchKey, setPunchKey] = useState<string>('');
  const [punchStatus, setPunchStatus] = useState<
    { kind: 'success'; remaining: number } | { kind: 'error'; message: string } | null
  >(null);
  const punchStatusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(punchStatusTimer.current), []);
  const flashStatus = (next: NonNullable<typeof punchStatus>, ms = 2500) => {
    setPunchStatus(next);
    clearTimeout(punchStatusTimer.current);
    punchStatusTimer.current = setTimeout(() => setPunchStatus(null), ms);
  };

  // Refund-entry state. refundEntryId targets a specific entry in the
  // currently-loaded customer detail. refundError surfaces server validation
  // errors (wrong admin password, etc.) inside the modal.
  const [refundEntryId, setRefundEntryId] = useState<string | null>(null);
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const closeRefundModal = () => {
    if (refundSubmitting) return;
    setRefundEntryId(null);
    setRefundError(null);
  };

  // New-customer form state. fieldErrors tracks per-field validation messages
  // shown inline below each input; topError is for non-field-specific failures.
  const [newFirst, setNewFirst] = useState('');
  const [newLast, setNewLast] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newFieldErrors, setNewFieldErrors] = useState<{
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    children?: string;
  }>({});
  const [newTopError, setNewTopError] = useState<string | null>(null);
  const [newSubmitting, setNewSubmitting] = useState(false);

  // Optional marketing fields (Yanai feedback item 2). All hidden under an
  // expandable section so the basic walk-in flow stays one-tap.
  // Default-open the optional extras when a child is required by settings —
  // otherwise the cashier never sees the children section without scrolling.
  const [newExtrasOpen, setNewExtrasOpen] = useState(false);
  useEffect(() => {
    if (formRules.requireChild) setNewExtrasOpen(true);
  }, [formRules.requireChild]);
  const [newSource, setNewSource] = useState<CustomerSourceValue | ''>('');
  const [newMarketingConsent, setNewMarketingConsent] = useState(false);
  const [newChildren, setNewChildren] = useState<ChildRecord[]>([]);

  const resetNewCustomerForm = () => {
    setNewFirst('');
    setNewLast('');
    setNewPhone('');
    setNewEmail('');
    setNewFieldErrors({});
    setNewTopError(null);
    setNewExtrasOpen(false);
    setNewSource('');
    setNewMarketingConsent(false);
    setNewChildren([]);
  };

  // Sell flow state: response from POST /cards (real serial to show on done)
  // and an error to surface on the confirm step.
  const [sellResponse, setSellResponse] = useState<SellCardResponse | null>(null);
  const [sellError, setSellError] = useState<string | null>(null);
  const [sellSubmitting, setSellSubmitting] = useState(false);

  const submitNewCustomer = async () => {
    const trimmedFirst = newFirst.trim();
    const trimmedLast = newLast.trim();
    const trimmedPhone = newPhone.trim();
    const trimmedEmail = newEmail.trim();

    const errors: typeof newFieldErrors = {};
    if (!trimmedFirst) errors.firstName = 'שדה חובה';
    if (!trimmedLast) errors.lastName = 'שדה חובה';
    if (!trimmedPhone) errors.phone = 'שדה חובה';
    if (trimmedEmail && !/^\S+@\S+\.\S+$/.test(trimmedEmail)) errors.email = 'כתובת מייל לא תקינה';

    // Settings-driven required fields. Mirror the server validation client-side
    // so the cashier sees the inline error instead of round-tripping a 400.
    if (formRules.requireEmail && !trimmedEmail) errors.email = 'מייל חובה לפי ההגדרות';

    // Trim + validate child rows (only those the cashier added). A row with
    // a name MUST have a valid DOB; we don't allow half-filled rows to
    // silently land in the DB.
    const cleanChildren: ChildRecord[] = [];
    const dobRegex = /^\d{4}-\d{2}-\d{2}$/;
    for (const c of newChildren) {
      const cname = c.name.trim();
      const cdob = c.dob.trim();
      if (!cname && !cdob) continue;
      if (!cname || !dobRegex.test(cdob)) {
        errors.children = 'כל ילד שנוסף חייב לכלול שם ותאריך לידה תקין (YYYY-MM-DD).';
        break;
      }
      cleanChildren.push({ name: cname, dob: cdob });
    }
    if (formRules.requireChild && cleanChildren.length === 0) {
      errors.children = 'חובה להוסיף לפחות ילד אחד לפי ההגדרות';
    }

    if (Object.keys(errors).length > 0) {
      setNewFieldErrors(errors);
      setNewTopError(null);
      return;
    }

    setNewSubmitting(true);
    setNewFieldErrors({});
    setNewTopError(null);
    const maskedPhone = `${trimmedPhone.slice(0, 3)}***`;
    console.info('[web newcustomer] submit', { phone: maskedPhone });
    const res = await createCustomer({
      firstName: trimmedFirst,
      lastName: trimmedLast,
      phone: trimmedPhone,
      ...(trimmedEmail !== '' && { email: trimmedEmail }),
      ...(newSource !== '' && { source: newSource }),
      ...(cleanChildren.length > 0 && { children: cleanChildren }),
      ...(newMarketingConsent && { marketingConsent: true }),
    });
    setNewSubmitting(false);

    if (!res.ok) {
      console.warn('[web newcustomer] error', { status: res.status, error: res.error });
      if (res.error === 'phone_taken') {
        setNewFieldErrors({ phone: 'מספר הטלפון כבר רשום במערכת' });
      } else if (res.error === 'email_required') {
        setNewFieldErrors({ email: 'מייל חובה לפי ההגדרות' });
      } else if (res.error === 'child_required') {
        setNewFieldErrors({ children: 'חובה להוסיף לפחות ילד אחד לפי ההגדרות' });
      } else if (res.error === 'invalid_body') {
        setNewTopError('אחד השדות לא תקין. בדקו ונסו שוב.');
      } else {
        setNewTopError('לא ניתן לרשום את הלקוח כרגע. נסו שוב בעוד רגע.');
      }
      return;
    }

    console.info('[web newcustomer] success', {
      id: res.data.customer.id,
      customerNumber: res.data.customer.customerNumber,
    });
    setSelectedId(res.data.customer.id);
    resetNewCustomerForm();
    setSellResponse(null);
    setSellError(null);
    setSellStep('choose');
    setScreen('sell');
  };

  // Issue the actual sell call. Split out so the PIN modal can resume the
  // flow after the cashier enters their code without duplicating the body
  // validation.
  const executeSell = async (pin: string | undefined) => {
    if (!selectedId) {
      setSellError('בחרו לקוח לפני המכירה.');
      return;
    }
    setSellSubmitting(true);
    setSellError(null);
    const trimmedReceipt = receiptNumber.trim();
    console.info('[pos sell] submit', {
      customerId: selectedId,
      hasReceipt: trimmedReceipt.length > 0,
      hasPin: Boolean(pin),
    });
    const res = await sellCard({
      customerId: selectedId,
      ...(trimmedReceipt !== '' && { receiptNumber: trimmedReceipt }),
      ...(pin !== undefined && { sellerPin: pin }),
    });
    setSellSubmitting(false);
    if (!res.ok) {
      console.warn('[pos sell] error', { status: res.status, error: res.error });
      // PIN-related rejections invalidate the cached PIN so the next attempt
      // re-prompts. Lockout errors clear the cache too so a new shift cannot
      // retry the locked PIN by accident.
      if (
        sessionUser &&
        (res.error === 'invalid_pin' ||
          res.error === 'pin_locked' ||
          res.error === 'pin_locked_now' ||
          res.error === 'pin_not_set')
      ) {
        clearCachedPin(sessionUser.id);
      }
      setSellError(humanizeSellError(res.error));
      return;
    }
    console.info('[pos sell] success', {
      cardId: res.data.card.id,
      serial: res.data.card.serialNumber,
    });
    console.info('[pos card] qr rendered', {
      ctx: 'post-sale',
      serial: res.data.card.serialNumber,
      tokenLen: res.data.card.qrToken.length,
    });
    // Refresh the PIN's sliding-window expiry on every successful sale.
    if (sessionUser && pin) {
      writeCachedPin(sessionUser.id, pin, sellControls.pinMemoryMinutes);
    }
    setSellResponse(res.data);
    setSellStep('done');
  };

  const submitSell = async () => {
    if (!selectedId) {
      setSellError('בחרו לקוח לפני המכירה.');
      return;
    }
    // Settings-driven field validation. The server re-validates; this just
    // avoids round-tripping for an obviously incomplete submit.
    if (sellControls.requireReceiptNumberOnPos && receiptNumber.trim() === '') {
      setSellError('יש להזין את מספר הקבלה לפני המכירה.');
      return;
    }
    if (!nameOnReceiptChecked) {
      setSellError('יש לסמן שרשמתם את שם הלקוח על הקבלה לפני המכירה.');
      return;
    }
    if (sellControls.requireSellerPin) {
      const cached = sessionUser ? readCachedPin(sessionUser.id) : null;
      if (cached) {
        await executeSell(cached);
      } else {
        // Defer the call — the PIN modal opens, collects the code, then
        // resumes via onPinModalConfirm.
        setSellError(null);
        setPinModalOpen(true);
      }
    } else {
      await executeSell(undefined);
    }
  };

  const onPinModalConfirm = async (pin: string) => {
    setPinModalOpen(false);
    await executeSell(pin);
  };

  // "Switch cashier" — clears the in-tab PIN cache so the next sale prompts
  // again. Useful when two cashiers share a device mid-shift.
  const switchCashier = () => {
    if (sessionUser) clearCachedPin(sessionUser.id);
    setSellError(null);
  };

  // Affordance from the Customer detail screen ("no active card" branch): sell
  // a new card to the customer we are already looking at.
  const sellNewForSelectedCustomer = () => {
    setSellResponse(null);
    setSellError(null);
    setSellStep('choose');
    setScreen('sell');
  };

  // Debounced search effect: 250ms after typing stops, fetch /customers?q=...
  // and abort if the user types again before the fetch resolves.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);
      console.info('[web search] fire', { q });
      const res = await searchCustomers(q, { signal: controller.signal });
      if (controller.signal.aborted) {
        console.info('[web search] aborted', { q });
        return;
      }
      setSearchLoading(false);
      if (res.ok) {
        setSearchResults(res.data.results);
      } else {
        setSearchError(res.error);
        setSearchResults([]);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Customer detail effect: load the selected customer + cards + entries.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      setDetailError(null);
      const res = await getCustomerDetail(selectedId);
      if (cancelled) return;
      setDetailLoading(false);
      if (res.ok) {
        setDetail(res.data);
      } else {
        setDetail(null);
        setDetailError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Diagnostic for the active-card QR render. Length only, never the token —
  // enough to confirm wiring without giving a console screenshot punch power.
  useEffect(() => {
    if (!detail) return;
    const active = pickActiveCard(detail.cards);
    if (!active) return;
    console.info('[pos card] qr rendered', {
      ctx: 'active-card',
      serial: active.serialNumber,
      tokenLen: active.qrToken.length,
    });
  }, [detail]);

  // Open the entries-to-consume modal. A fresh UUID lives for this intent only.
  const openPunch = () => {
    setPunchKey(crypto.randomUUID());
    setAskPunch(true);
    setPunchStatus(null);
    console.info('[web punch] open');
  };

  // The actual call. Closes the modal, posts to the API, refetches detail on
  // success, surfaces a Hebrew error otherwise.
  const confirmPunch = async (entriesArg: number) => {
    if (!detail) return;
    const active = pickActiveCard(detail.cards);
    if (!active) return;
    setPunching(true);
    console.info('[web punch] submit', { entries: entriesArg });
    const res = await punchBySerial(active.serialNumber, {
      entries: entriesArg,
      idempotencyKey: punchKey,
    });
    setPunching(false);
    setAskPunch(false);
    if (res.ok) {
      console.info('[web punch] success', {
        remaining: res.data.remaining,
        replay: res.data.replay,
      });
      flashStatus({ kind: 'success', remaining: res.data.remaining });
      // Refetch detail so the pebbles + history list reflect the new state.
      if (selectedId) {
        const refreshed = await getCustomerDetail(selectedId);
        if (refreshed.ok) setDetail(refreshed.data);
      }
    } else {
      console.warn('[web punch] error', { status: res.status, error: res.error });
      flashStatus({ kind: 'error', message: humanizePunchError(res.error) }, 4000);
    }
  };

  const openCustomer = (id: string) => {
    setSelectedId(id);
    setScreen('customer');
  };

  // Refund a single entry. Cashier+manager require an admin password (the
  // modal collects it); admin users self-approve and pass `undefined`.
  // Always re-fetches the customer detail on success so the entries list +
  // pebbles reflect the decremented usedEntries.
  const submitRefund = async (
    cardId: string,
    entryId: string,
    reason: string,
    adminPassword: string | undefined,
  ) => {
    setRefundSubmitting(true);
    setRefundError(null);
    console.info('[web refund] submit', { entryId, hasAdminPassword: Boolean(adminPassword) });
    const res = await refundEntry(cardId, entryId, {
      reason,
      ...(adminPassword !== undefined && { adminPassword }),
    });
    setRefundSubmitting(false);
    if (!res.ok) {
      console.warn('[web refund] error', { status: res.status, error: res.error });
      setRefundError(humanizeRefundError(res.error));
      return;
    }
    console.info('[web refund] success', {
      entryId,
      reactivated: res.data.reactivated,
      remaining: res.data.remaining,
    });
    setRefundEntryId(null);
    flashStatus({ kind: 'success', remaining: res.data.remaining });
    if (selectedId) {
      const refreshed = await getCustomerDetail(selectedId);
      if (refreshed.ok) setDetail(refreshed.data);
    }
  };

  return (
    <>
      <main style={{ maxWidth: 920, margin: '0 auto', padding: '24px 20px 64px' }}>
        {screen === 'home' && <Home />}
        {screen === 'search' && <Search />}
        {screen === 'customer' && <Customer />}
        {screen === 'new' && <NewCustomer />}
        {screen === 'sell' && <Sell />}
        {screen === 'scan' && <Scan onClose={() => setScreen('home')} />}
      </main>
      {pinModalOpen && sessionUser && (
        <SellerPinModal
          firstName={sessionUser.firstName}
          length={sellControls.pinLength}
          onCancel={() => {
            setPinModalOpen(false);
            setSellError(null);
          }}
          onConfirm={(pin) => void onPinModalConfirm(pin)}
        />
      )}
      {selfPinModalOpen && (
        <SelfPinModal
          length={sellControls.pinLength}
          onClose={() => setSelfPinModalOpen(false)}
        />
      )}
    </>
  );

  function Home() {
    const tiles = [
      {
        label: 'חיפוש לקוח',
        sub: 'לפי שם, טלפון או מספר',
        bg: 'linear-gradient(160deg,#fff,#fff8f3)',
        border: '#ffe3d4',
        tint: '#fff4ee',
        onClick: () => setScreen('search'),
      },
      {
        label: 'לקוח חדש',
        sub: 'רישום ומכירת כרטיסייה',
        bg: 'linear-gradient(160deg,#fff,#f8fbef)',
        border: '#e7eed6',
        tint: '#f3f7e8',
        onClick: () => setScreen('new'),
      },
      {
        label: 'סריקת QR',
        sub: 'ניקוב כניסה מהיר',
        bg: ORANGE,
        border: ORANGE,
        tint: 'rgba(255,255,255,0.28)',
        onClick: () => setScreen('scan'),
      },
    ];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 24, fontWeight: 600 }}>
              {greetingFor(new Date())}
              {sessionUser ? `, ${sessionUser.firstName}` : ''}
            </div>
            <div style={{ color: MUTED, marginTop: 4 }}>{hebrewDate(new Date())}</div>
          </div>
          {sellControls.requireSellerPin && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={switchCashier}
                title="מחק את הקוד שנזכר בדפדפן כדי שהקופאי הבא יזין את שלו"
                style={{
                  border: '1.5px solid #e9e0d9',
                  background: '#fff',
                  color: MUTED,
                  borderRadius: 10,
                  padding: '8px 14px',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                החלף קופאי
              </button>
              <button
                type="button"
                onClick={() => setSelfPinModalOpen(true)}
                style={{
                  border: '1.5px solid #e9e0d9',
                  background: '#fff',
                  color: MUTED,
                  borderRadius: 10,
                  padding: '8px 14px',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                ניהול הקוד שלי
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Stat label="כניסות היום" value="0" />
          <Stat label="כרטיסיות שנמכרו היום" value="0" />
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
            gap: 16,
          }}
        >
          {tiles.map((t) => {
            const onOrange = t.label === 'סריקת QR';
            return (
              <button
                key={t.label}
                onClick={t.onClick}
                style={{
                  cursor: 'pointer',
                  textAlign: 'right',
                  border: `1px solid ${t.border}`,
                  background: t.bg,
                  borderRadius: 18,
                  boxShadow: SHADOW,
                  padding: '28px 24px',
                  minHeight: 180,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  color: onOrange ? '#fff' : INK,
                }}
              >
                <div
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 16,
                    background: t.tint,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Sun size={34} ring={!onOrange} />
                </div>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 600 }}>{t.label}</div>
                  <div
                    style={{
                      fontSize: 14,
                      marginTop: 4,
                      color: onOrange ? 'rgba(255,255,255,0.9)' : MUTED,
                    }}
                  >
                    {t.sub}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function Search() {
    const q = query.trim();
    const showEmpty = q.length > 0 && !searchLoading && !searchError && searchResults.length === 0;
    return (
      <div>
        <BackBar label="חזרה" onClick={() => setScreen('home')} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="שם, טלפון או מספר לקוח…"
          style={inputStyle}
        />
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {searchLoading && <div style={{ ...card, textAlign: 'center', color: MUTED }}>מחפש…</div>}
          {searchError && (
            <div style={{ ...card, textAlign: 'center', color: '#a23a3a' }}>
              שגיאה בחיפוש. נסו שוב בעוד רגע.
            </div>
          )}
          {searchResults.map((c) => {
            const a = realAvatar(c.id);
            return (
              <button
                key={c.id}
                onClick={() => openCustomer(c.id)}
                style={{
                  ...card,
                  padding: 14,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  cursor: 'pointer',
                  border: 'none',
                  textAlign: 'right',
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: a.bg,
                    color: a.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 600,
                  }}
                >
                  {realInitials(c)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{realFullName(c)}</div>
                  <div style={{ fontSize: 13, color: MUTED }}>
                    {c.phone} · {c.customerNumber}
                  </div>
                </div>
              </button>
            );
          })}
          {searchResults.length === 20 && (
            <div style={{ ...card, textAlign: 'center', color: MUTED, fontSize: 13 }}>
              מוצגים 20 הראשונים. המשיכו לסנן לחיפוש מדויק יותר.
            </div>
          )}
          {showEmpty && (
            <div style={{ ...card, textAlign: 'center', color: MUTED }}>
              לא נמצאו לקוחות שמתאימים לחיפוש
            </div>
          )}
        </div>
      </div>
    );
  }

  function Customer() {
    if (detailLoading) {
      return (
        <div>
          <BackBar label="חזרה לחיפוש" onClick={() => setScreen('search')} />
          <div style={{ ...card, textAlign: 'center', color: MUTED }}>טוען פרטי לקוח…</div>
        </div>
      );
    }
    if (detailError || !detail) {
      return (
        <div>
          <BackBar label="חזרה לחיפוש" onClick={() => setScreen('search')} />
          <div style={{ ...card, textAlign: 'center', color: '#a23a3a' }}>
            לא הצלחנו לטעון את פרטי הלקוח. חזרו לחיפוש ונסו שוב.
          </div>
        </div>
      );
    }
    const { customer: cust, cards, entries } = detail;
    const a = realAvatar(cust.id);
    const activeCard = pickActiveCard(cards);
    return (
      <div>
        <BackBar label="חזרה לחיפוש" onClick={() => setScreen('search')} />
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: a.bg,
              color: a.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 600,
              fontSize: 18,
            }}
          >
            {realInitials(cust)}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{realFullName(cust)}</div>
            <div style={{ fontSize: 14, color: MUTED }}>
              {cust.phone} · {cust.customerNumber}
            </div>
          </div>
        </div>

        {activeCard ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))',
              gap: 16,
            }}
          >
            <div
              style={{
                ...card,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 14,
              }}
            >
              <PunchCard used={activeCard.usedEntries} total={activeCard.totalEntries} />
              <button
                onClick={openPunch}
                disabled={!activeCard.isActive || activeCard.usedEntries >= activeCard.totalEntries}
                style={{
                  ...primaryBtn,
                  width: '100%',
                  opacity:
                    !activeCard.isActive || activeCard.usedEntries >= activeCard.totalEntries
                      ? 0.5
                      : 1,
                  cursor:
                    !activeCard.isActive || activeCard.usedEntries >= activeCard.totalEntries
                      ? 'not-allowed'
                      : 'pointer',
                }}
              >
                ניקוב כניסה
              </button>
              {punchStatus?.kind === 'success' && (
                <div
                  role="status"
                  style={{ fontSize: 13, color: '#6f8f37', fontWeight: 600, textAlign: 'center' }}
                >
                  ✓ נוצב · נותרו {punchStatus.remaining}
                </div>
              )}
              {punchStatus?.kind === 'error' && (
                <div role="alert" style={{ fontSize: 13, color: '#a23a3a', textAlign: 'center' }}>
                  {punchStatus.message}
                </div>
              )}
            </div>
            <div
              style={{
                ...card,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <MemeshQr
                value={activeCard.qrToken}
                size={200}
                title={`קוד QR — ${activeCard.serialNumber}`}
              />
              <div style={{ fontSize: 13, color: MUTED }}>{activeCard.serialNumber}</div>
              <div style={{ fontSize: 13, color: MUTED }}>
                {activeCard.expiresAt === null
                  ? 'ללא תפוגה'
                  : `תוקף עד ${fmtDate(yyyyMmDd(activeCard.expiresAt))}`}
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              ...card,
              textAlign: 'center',
              color: MUTED,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              alignItems: 'center',
            }}
          >
            <div>ללקוח אין כרטיסייה פעילה.</div>
            <button
              style={{ ...primaryBtn, padding: '12px 24px' }}
              onClick={sellNewForSelectedCustomer}
            >
              מכירת כרטיסייה חדשה
            </button>
          </div>
        )}

        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>היסטוריית כניסות</div>
          {entries.length === 0 && (
            <div style={{ color: MUTED, fontSize: 14 }}>אין כניסות עדיין.</div>
          )}
          {entries.map((h, i) => {
            const refunded = h.refundedAt !== null;
            return (
              <div
                key={h.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 0',
                  borderTop: i ? '1px solid #f3efea' : 'none',
                  fontSize: 14,
                  opacity: refunded ? 0.55 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      textDecoration: refunded ? 'line-through' : 'none',
                    }}
                  >
                    {fmtDate(yyyyMmDd(h.punchedAt))} · {hhMm(h.punchedAt)}
                    <span style={{ color: MUTED, marginInlineStart: 8 }}>
                      · {entriesLabel(h.entriesConsumed)}
                    </span>
                  </div>
                  {refunded && (
                    <div style={{ fontSize: 12.5, color: '#a23a3a', marginTop: 2 }}>
                      הוחזר{h.refundReason ? ` · ${h.refundReason}` : ''}
                    </div>
                  )}
                </div>
                {!refunded && (
                  <button
                    type="button"
                    onClick={() => {
                      setRefundError(null);
                      setRefundEntryId(h.id);
                    }}
                    style={{
                      border: '1.5px solid #e9e0d9',
                      background: '#fff',
                      color: MUTED,
                      borderRadius: 8,
                      padding: '5px 10px',
                      fontWeight: 600,
                      fontSize: 12.5,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    החזר
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>ילדים</div>
          {cust.children.length === 0 ? (
            <div style={{ fontSize: 14, color: MUTED }}>לא נרשמו ילדים.</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {cust.children.map((k) => (
                <span
                  key={k.name}
                  style={{
                    background: '#f3f7e8',
                    color: '#6f8f37',
                    borderRadius: 10,
                    padding: '6px 12px',
                    fontSize: 13.5,
                  }}
                >
                  {k.name}
                </span>
              ))}
            </div>
          )}
          <div style={{ fontWeight: 600, margin: '14px 0 6px' }}>הערת צוות פנימית</div>
          <div style={{ fontSize: 14, color: MUTED }}>{cust.internalNotes || 'אין הערות.'}</div>
        </div>

        {askPunch && activeCard && (
          <PunchConfirmModal
            onClose={() => setAskPunch(false)}
            onConfirm={confirmPunch}
            submitting={punching}
            maxEntries={Math.max(1, activeCard.totalEntries - activeCard.usedEntries)}
          />
        )}

        {refundEntryId &&
          (() => {
            const target = entries.find((e) => e.id === refundEntryId);
            if (!target) return null;
            const summary = `${fmtDate(yyyyMmDd(target.punchedAt))} · ${hhMm(target.punchedAt)} · ${entriesLabel(
              target.entriesConsumed,
            )}`;
            return (
              <RefundEntryModal
                entrySummary={summary}
                selfApprove={sessionUser?.role === 'admin'}
                submitting={refundSubmitting}
                error={refundError}
                onClose={closeRefundModal}
                onConfirm={(reason, password) =>
                  void submitRefund(target.punchCardId, target.id, reason, password)
                }
              />
            );
          })()}
      </div>
    );
  }

  function NewCustomer() {
    return (
      <div>
        <BackBar
          label="חזרה"
          onClick={() => {
            resetNewCustomerForm();
            setScreen('home');
          }}
        />
        <div style={{ ...card }}>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>לקוח חדש</div>
          <div style={{ color: MUTED, fontSize: 14, marginBottom: 18 }}>
            פרטי הלקוח יישמרו וניתן יהיה למכור כרטיסייה מיד
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitNewCustomer();
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
                gap: 14,
              }}
            >
              <NewCustomerField
                label="שם פרטי"
                required
                value={newFirst}
                onChange={setNewFirst}
                error={newFieldErrors.firstName}
                autoComplete="given-name"
                submitting={newSubmitting}
              />
              <NewCustomerField
                label="שם משפחה"
                required
                value={newLast}
                onChange={setNewLast}
                error={newFieldErrors.lastName}
                autoComplete="family-name"
                submitting={newSubmitting}
              />
              <NewCustomerField
                label="טלפון"
                required
                value={newPhone}
                onChange={setNewPhone}
                error={newFieldErrors.phone}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="050-000-0000"
                submitting={newSubmitting}
              />
              <NewCustomerField
                label="מייל"
                required={formRules.requireEmail}
                badge={formRules.requireEmail ? undefined : 'מומלץ'}
                value={newEmail}
                onChange={setNewEmail}
                error={newFieldErrors.email}
                type="email"
                inputMode="email"
                autoComplete="email"
                submitting={newSubmitting}
              />
            </div>
            {!formRules.requireEmail && (
              <div
                style={{
                  fontSize: 12.5,
                  color: MUTED,
                  marginTop: 6,
                  lineHeight: 1.4,
                }}
              >
                {sellControls.emailNudgeText}
              </div>
            )}

            <NewCustomerExtras
              open={newExtrasOpen}
              onToggle={() => setNewExtrasOpen((v) => !v)}
              source={newSource}
              onSourceChange={setNewSource}
              marketingConsent={newMarketingConsent}
              onMarketingConsentChange={setNewMarketingConsent}
              children={newChildren}
              onChildrenChange={setNewChildren}
              submitting={newSubmitting}
              childrenError={newFieldErrors.children}
            />

            {newTopError && (
              <div
                role="alert"
                style={{
                  marginTop: 16,
                  padding: '10px 14px',
                  background: '#fbecec',
                  color: '#a23a3a',
                  borderRadius: 10,
                  fontSize: 14,
                }}
              >
                {newTopError}
              </div>
            )}
            <button
              type="submit"
              disabled={newSubmitting}
              style={{
                ...primaryBtn,
                width: '100%',
                marginTop: 20,
                opacity: newSubmitting ? 0.6 : 1,
                cursor: newSubmitting ? 'default' : 'pointer',
              }}
            >
              {newSubmitting ? 'שומר…' : 'שמור ומכור כרטיסייה'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  function Sell() {
    return (
      <div>
        <BackBar label="חזרה" onClick={() => setScreen('home')} />
        {sellStep === 'choose' && (
          <div style={{ ...card }}>
            <div style={{ fontSize: 20, fontWeight: 600 }}>מכירת כרטיסייה</div>
            <div
              style={{
                ...card,
                background: '#fff8f3',
                boxShadow: 'none',
                border: '1px solid #ffe3d4',
                marginTop: 16,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 18 }}>כרטיסייה</div>
              <div style={{ color: MUTED, fontSize: 14, marginTop: 4 }}>{pricing.pitchLabel}</div>
              <div style={{ fontSize: 36, fontWeight: 600, color: ORANGE, marginTop: 12 }}>
                ₪{pricing.priceShekels}
              </div>
              <div style={{ color: MUTED, fontSize: 13.5, marginTop: 4 }}>
                ניקוב גמיש — בוחרים בקופה כמה כניסות לסמן בכל סריקה
              </div>
            </div>
            <button
              style={{ ...primaryBtn, width: '100%', marginTop: 18 }}
              onClick={() => setSellStep('confirm')}
            >
              המשך לתשלום
            </button>
          </div>
        )}
        {sellStep === 'confirm' && (
          <div style={{ ...card }}>
            <div style={{ fontSize: 20, fontWeight: 600 }}>סכום לתשלום</div>
            <div style={{ fontSize: 40, fontWeight: 600, color: ORANGE, margin: '8px 0 14px' }}>
              ₪{pricing.priceShekels}
            </div>
            <div style={{ color: MUTED, fontSize: 14 }}>
              החיוב מתבצע בקופה החיצונית. לאחר אישור התשלום, לחצו "אושר".
            </div>

            {sellControls.requireReceiptNumberOnPos && (
              <div style={{ marginTop: 18 }}>
                <label
                  htmlFor="pos-receipt-number"
                  style={{
                    display: 'block',
                    fontSize: 13.5,
                    color: MUTED,
                    marginBottom: 6,
                    fontWeight: 600,
                  }}
                >
                  מספר קבלה *
                </label>
                <input
                  id="pos-receipt-number"
                  value={receiptNumber}
                  onChange={(e) => setReceiptNumber(e.target.value)}
                  inputMode="text"
                  autoComplete="off"
                  placeholder="מספר הקבלה שהדפסת בקופה"
                  disabled={sellSubmitting}
                  style={{
                    width: '100%',
                    fontSize: 16,
                    padding: '12px 14px',
                    border: '1.5px solid #e9e0d9',
                    borderRadius: 10,
                    background: '#fff',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            )}

            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                marginTop: 14,
                padding: '10px 12px',
                border: '1.5px solid #e9e0d9',
                borderRadius: 10,
                background: '#fffaf5',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={nameOnReceiptChecked}
                onChange={(e) => setNameOnReceiptChecked(e.target.checked)}
                disabled={sellSubmitting}
                style={{ marginTop: 3 }}
              />
              <span style={{ fontSize: 14, color: INK, lineHeight: 1.4 }}>
                {sellControls.nameOnReceiptLabel}
              </span>
            </label>

            <div style={{ fontWeight: 600, margin: '18px 0 10px' }}>הלקוח שולם בקופה?</div>
            {sellError && (
              <div
                role="alert"
                style={{
                  marginBottom: 12,
                  padding: '10px 14px',
                  background: '#fbecec',
                  color: '#a23a3a',
                  borderRadius: 10,
                  fontSize: 14,
                }}
              >
                {sellError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                style={{ ...ghostBtn, flex: 1 }}
                onClick={() => setSellStep('choose')}
                disabled={sellSubmitting}
              >
                ביטול
              </button>
              <button
                style={{
                  ...primaryBtn,
                  flex: 1,
                  opacity: sellSubmitting || !nameOnReceiptChecked ? 0.6 : 1,
                  cursor:
                    sellSubmitting || !nameOnReceiptChecked ? 'not-allowed' : 'pointer',
                }}
                onClick={() => void submitSell()}
                disabled={sellSubmitting || !nameOnReceiptChecked}
              >
                {sellSubmitting ? 'יוצר…' : 'אושר'}
              </button>
            </div>
          </div>
        )}
        {sellStep === 'done' && sellResponse && (
          <div style={{ ...card, textAlign: 'center' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                animation: 'memesh-burst 0.5s ease',
              }}
            >
              <Sun size={96} />
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, marginTop: 12 }}>הכרטיסייה נוצרה!</div>
            <div style={{ color: MUTED, fontSize: 14, marginTop: 6 }}>
              הכרטיסייה זמינה בכרטיס הלקוח. שליחת ה-SMS עם ה-QR תיכנס בעדכון הבא.
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '18px 0' }}>
              <MemeshQr
                value={sellResponse.card.qrToken}
                size={200}
                title={`קוד QR — ${sellResponse.card.serialNumber}`}
              />
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 4 }}>
              {sellResponse.card.serialNumber}
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 14 }}>
              {sellResponse.card.expiresAt === null
                ? 'ללא תפוגה'
                : `תוקף עד ${fmtDate(yyyyMmDd(sellResponse.card.expiresAt))}`}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                style={{ ...ghostBtn, flex: 1 }}
                onClick={() => {
                  if (selectedId) {
                    setScreen('customer');
                  } else {
                    setScreen('home');
                  }
                }}
              >
                לכרטיס הלקוח
              </button>
              <button
                style={{ ...primaryBtn, flex: 1 }}
                onClick={() => {
                  setScreen('home');
                }}
              >
                חזרה למסך הראשי
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

}

// ---------------------------------------------------------------------------
// BackBar — top-of-screen back link. Lifted to module scope so it has a stable
// component identity across PosApp re-renders; declaring it inside PosApp
// caused every sibling <input> to unmount on each keystroke.
// ---------------------------------------------------------------------------

function BackBar({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none',
        background: 'transparent',
        color: MUTED,
        cursor: 'pointer',
        fontSize: 15,
        padding: '4px 0',
        marginBottom: 12,
      }}
    >
      ← {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stat — small metric tile on the home screen. Pure presentational; lifted
// alongside BackBar for the same render-stability reason.
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ ...card, padding: '14px 22px', minWidth: 150 }}>
      <div style={{ fontSize: 30, fontWeight: 600, color: ORANGE }}>{value}</div>
      <div style={{ fontSize: 13.5, color: MUTED, marginTop: 2 }}>{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NewCustomerField — labelled text input used by the New Customer form. The
// `submitting` prop replaces a closure over the parent's newSubmitting state;
// lifting eliminates the per-keystroke remount that wiped focus mid-typing.
// ---------------------------------------------------------------------------

function NewCustomerField({
  label,
  value,
  onChange,
  required,
  badge,
  error,
  type,
  inputMode,
  autoComplete,
  placeholder,
  submitting,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  required?: boolean | undefined;
  badge?: string | undefined;
  error?: string | undefined;
  type?: 'text' | 'tel' | 'email' | undefined;
  inputMode?: 'tel' | 'email' | 'text' | undefined;
  autoComplete?: string | undefined;
  placeholder?: string | undefined;
  submitting: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 13.5,
          color: MUTED,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>
          {label}
          {required ? ' *' : ''}
        </span>
        {badge && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#a8643d',
              background: '#fff4ee',
              border: '1px solid #ffe3d4',
              borderRadius: 999,
              padding: '2px 8px',
            }}
          >
            {badge}
          </span>
        )}
      </span>
      <input
        style={{
          ...inputStyle,
          borderColor: error ? '#e8a4a4' : '#e9e0d9',
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type ?? 'text'}
        {...(inputMode !== undefined && { inputMode })}
        {...(autoComplete !== undefined && { autoComplete })}
        {...(placeholder !== undefined && { placeholder })}
        disabled={submitting}
        aria-invalid={Boolean(error)}
      />
      {error && (
        <span style={{ fontSize: 12.5, color: '#a23a3a' }} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------
// NewCustomerExtras — collapsible "more details" panel inside the New Customer
// form: marketing source, children list, marketing consent. Already fully
// prop-driven, so the lift is mechanical; gains the same render-stability
// benefit as NewCustomerField.
// ---------------------------------------------------------------------------

function NewCustomerExtras({
  open,
  onToggle,
  source,
  onSourceChange,
  marketingConsent,
  onMarketingConsentChange,
  children: kids,
  onChildrenChange,
  submitting,
  childrenError,
}: {
  open: boolean;
  onToggle: () => void;
  source: CustomerSourceValue | '';
  onSourceChange: (next: CustomerSourceValue | '') => void;
  marketingConsent: boolean;
  onMarketingConsentChange: (next: boolean) => void;
  children: ChildRecord[];
  onChildrenChange: (next: ChildRecord[]) => void;
  submitting: boolean;
  childrenError?: string | undefined;
}) {
  const sourceOptions: { value: CustomerSourceValue | ''; label: string }[] = [
    { value: '', label: 'לא צוין' },
    { value: 'referral', label: 'חבר/ה' },
    { value: 'social', label: 'רשתות חברתיות' },
    { value: 'walk_by', label: 'עברתי ברחוב' },
    { value: 'website', label: 'אתר אינטרנט' },
    { value: 'other', label: 'אחר' },
  ];

  const updateChild = (i: number, patch: Partial<ChildRecord>) => {
    onChildrenChange(kids.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };
  const removeChild = (i: number) => {
    onChildrenChange(kids.filter((_, idx) => idx !== i));
  };
  const addChild = () => {
    onChildrenChange([...kids, { name: '', dob: '' }]);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          background: '#fff8f3',
          border: '1px solid #ffe3d4',
          color: '#a8643d',
          borderRadius: 10,
          padding: '10px 14px',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          justifyContent: 'space-between',
        }}
      >
        <span>פרטים נוספים (לא חובה)</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div
          style={{
            border: '1px solid #f3efea',
            borderRadius: 10,
            padding: 14,
            marginTop: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13.5, color: MUTED }}>איך שמעת עלינו?</span>
            <select
              value={source}
              onChange={(e) => onSourceChange(e.target.value as CustomerSourceValue | '')}
              disabled={submitting}
              style={{ ...inputStyle, paddingInlineEnd: 32 }}
            >
              {sourceOptions.map((o) => (
                <option key={o.value || 'none'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 13.5, color: MUTED }}>ילדים</span>
              <button
                type="button"
                onClick={addChild}
                disabled={submitting}
                style={{
                  background: '#fff',
                  border: '1.5px solid #e9e0d9',
                  color: MUTED,
                  borderRadius: 8,
                  padding: '6px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                + הוסף ילד
              </button>
            </div>
            {kids.length === 0 ? (
              <div style={{ fontSize: 13, color: MUTED, fontStyle: 'italic' }}>
                לא נרשמו ילדים. הוספה מועילה לתזכורות יום-הולדת בהמשך.
              </div>
            ) : (
              kids.map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 140px auto',
                    gap: 8,
                    alignItems: 'center',
                    marginTop: 8,
                  }}
                >
                  <input
                    type="text"
                    value={c.name}
                    onChange={(e) => updateChild(i, { name: e.target.value })}
                    placeholder="שם הילד/ה"
                    disabled={submitting}
                    style={inputStyle}
                  />
                  <input
                    type="date"
                    value={c.dob}
                    onChange={(e) => updateChild(i, { dob: e.target.value })}
                    disabled={submitting}
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => removeChild(i)}
                    disabled={submitting}
                    aria-label={`הסר ילד ${i + 1}`}
                    style={{
                      border: '1.5px solid #e8a4a4',
                      background: '#fff',
                      color: '#c25a5a',
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: 14,
                      cursor: 'pointer',
                    }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
            {childrenError && (
              <div style={{ fontSize: 12.5, color: '#a23a3a', marginTop: 8 }} role="alert">
                {childrenError}
              </div>
            )}
          </div>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              fontSize: 14,
              color: INK,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={marketingConsent}
              onChange={(e) => onMarketingConsentChange(e.target.checked)}
              disabled={submitting}
              style={{ marginTop: 3 }}
            />
            <span>
              אני מסכים/ה לקבל הודעות על מבצעים ואירועים
              <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                לא נשלח שום הודעת שיווק ללא הסימון הזה.
              </div>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scan — full-screen scan/punch flow: camera scan, fallback serial entry,
// preview lookup, entries-picker modal, success and error tails. Owns its own
// phase state internally; the only outer dependency is onClose (navigate back).
// ---------------------------------------------------------------------------

type ScanPhase =
  | 'camera'
  | 'serial'
  | 'loading-preview'
  | 'confirming'
  | 'submitting'
  | 'success'
  | 'error';
type ScanSource = { mode: 'token'; token: string } | { mode: 'serial'; serial: string };

function Scan({ onClose }: { onClose: () => void }) {
  // 'loading-preview' fetches /scan/lookup before the modal opens, so the
  // cashier sees customer + card context (and a red banner for problem
  // cards) instead of a blank entries picker.
  const [phase, setPhase] = useState<ScanPhase>('camera');
  const [source, setSource] = useState<ScanSource | null>(null);
  const [scanKey, setScanKey] = useState('');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [result, setResult] = useState<{ remaining: number; total: number } | null>(null);
  const [punchErrorMsg, setPunchErrorMsg] = useState<string | null>(null);
  const [serialInput, setSerialInput] = useState('');
  const [serialFieldError, setSerialFieldError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ScanLookupResponse | null>(null);

  useEffect(() => {
    console.info('[web scan] mounted');
    return () => console.info('[web scan] unmounted');
  }, []);

  const reset = () => {
    setPhase('camera');
    setSource(null);
    setResult(null);
    setPunchErrorMsg(null);
    setSerialInput('');
    setSerialFieldError(null);
    setCameraError(null);
    setPreview(null);
  };

  // Fetch /scan/lookup using the captured source, then transition to the
  // confirming phase whether the card is punchable or not. The modal itself
  // decides whether to show the entries picker or the red banner based on
  // preview.status.
  //
  // TEMP DIAGNOSTIC: on an invalid_signature failure from the token path,
  // also call /debug/qr/verify so the modal surfaces the precise verifyToken
  // reason (bad_signature / unknown_key_id / invalid_format / …) instead of
  // the collapsed "QR לא תקין". Remove once the qr-verify investigation
  // closes — see _plans/2026-06-21-real-qr-codes.md.
  const fetchPreview = async (nextSource: ScanSource) => {
    setPhase('loading-preview');
    console.info('[web scan] preview fetch', { mode: nextSource.mode });
    const res =
      nextSource.mode === 'token'
        ? await lookupByToken(nextSource.token)
        : await lookupBySerial(nextSource.serial);
    if (res.ok) {
      console.info('[web scan] preview ok', { status: res.data.status });
      setPreview(res.data);
      setPhase('confirming');
      return;
    }
    console.warn('[web scan] preview error', { status: res.status, error: res.error });
    let message = humanizePunchError(res.error);
    if (res.error === 'invalid_signature' && nextSource.mode === 'token') {
      const dbg = await debugVerifyToken(nextSource.token);
      if (dbg.ok) {
        console.warn('[web scan] debug verify', dbg.data);
        message = `${message}\n(diag: ${dbg.data.verifyResult}; envKeyId=${dbg.data.envKeyId}; tokenKeyId=${dbg.data.tokenStructure.payloadKeyId ?? 'null'}; serial=${dbg.data.tokenStructure.payloadSerial ?? 'null'})`;
      } else {
        console.warn('[web scan] debug verify failed', { status: dbg.status, error: dbg.error });
        message = `${message}\n(diag unavailable: ${dbg.error})`;
      }
    }
    setPunchErrorMsg(message);
    setPhase('error');
  };

  const onScannerDetect = (codes: IDetectedBarcode[]) => {
    if (phase !== 'camera') return;
    const first = codes[0];
    if (!first?.rawValue) return;
    console.info('[web scan] detected', { tokenPrefix: first.rawValue.slice(0, 8) });
    const nextSource: ScanSource = { mode: 'token', token: first.rawValue };
    setSource(nextSource);
    setScanKey(crypto.randomUUID());
    void fetchPreview(nextSource);
  };

  const onScannerError = (err: unknown) => {
    const scannerErr = err as IScannerError;
    console.warn('[web scan] error', { kind: scannerErr.kind });
    setCameraError(humanizeScanError(scannerErr.kind));
  };

  const submitSerial = () => {
    const trimmed = serialInput.trim();
    if (!trimmed) {
      setSerialFieldError('נא להזין מספר סידורי');
      return;
    }
    setSerialFieldError(null);
    const nextSource: ScanSource = { mode: 'serial', serial: trimmed };
    setSource(nextSource);
    setScanKey(crypto.randomUUID());
    void fetchPreview(nextSource);
  };

  const confirmPunch = async (entries: number) => {
    if (!source) return;
    setPhase('submitting');
    setPunchErrorMsg(null);
    console.info('[web scan] punch submit', { mode: source.mode, entries });
    const res =
      source.mode === 'token'
        ? await punchByToken(source.token, { entries, idempotencyKey: scanKey })
        : await punchBySerial(source.serial, { entries, idempotencyKey: scanKey });
    if (res.ok) {
      console.info('[web scan] punch success', { remaining: res.data.remaining });
      setResult({ remaining: res.data.remaining, total: res.data.totalEntries });
      setPhase('success');
      return;
    }
    console.warn('[web scan] punch error', { status: res.status, error: res.error });
    setPunchErrorMsg(humanizePunchError(res.error));
    setPhase('error');
  };

  return (
    <div>
      <BackBar label="חזרה" onClick={onClose} />
      {phase === 'camera' && (
        <div style={{ ...card, textAlign: 'center' }}>
          <div
            style={{
              borderRadius: 16,
              overflow: 'hidden',
              aspectRatio: '4 / 3',
              background: INK,
              position: 'relative',
            }}
          >
            {cameraError ? (
              <div
                style={{
                  color: '#fff',
                  padding: 24,
                  fontSize: 14,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                }}
              >
                {cameraError}
              </div>
            ) : (
              <Scanner
                onScan={onScannerDetect}
                onError={onScannerError}
                constraints={{ facingMode: 'environment' }}
                styles={{
                  container: { width: '100%', height: '100%' },
                  video: { width: '100%', height: '100%', objectFit: 'cover' },
                }}
              />
            )}
          </div>
          <div style={{ color: MUTED, fontSize: 13.5, marginTop: 12 }}>
            מקמו את קוד ה-QR של הכרטיסייה במסגרת
          </div>
          <button
            style={{ ...ghostBtn, width: '100%', marginTop: 12 }}
            onClick={() => {
              setSerialInput('');
              setSerialFieldError(null);
              setPhase('serial');
            }}
          >
            הזנת מספר סידורי במקום
          </button>
        </div>
      )}

      {phase === 'serial' && (
        <div style={{ ...card }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>הזנת מספר סידורי</div>
          <div style={{ color: MUTED, fontSize: 13.5, marginBottom: 14 }}>
            מספר סידורי בפורמט M-YYYYMMDD-NNNN מודפס על הכרטיסייה
          </div>
          <input
            autoFocus
            value={serialInput}
            onChange={(e) => setSerialInput(e.target.value)}
            placeholder="M-20260618-0001"
            style={{
              ...inputStyle,
              borderColor: serialFieldError ? '#e8a4a4' : '#e9e0d9',
              letterSpacing: 1,
            }}
          />
          {serialFieldError && (
            <div style={{ fontSize: 12.5, color: '#a23a3a', marginTop: 6 }} role="alert">
              {serialFieldError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              style={{ ...ghostBtn, flex: 1 }}
              onClick={() => {
                setSerialInput('');
                setSerialFieldError(null);
                setPhase('camera');
              }}
            >
              חזרה לסריקה
            </button>
            <button style={{ ...primaryBtn, flex: 1 }} onClick={submitSerial}>
              המשך
            </button>
          </div>
        </div>
      )}

      {phase === 'loading-preview' && (
        <div style={{ ...card, textAlign: 'center', color: MUTED }}>
          טוען פרטי כרטיסייה…
        </div>
      )}

      {(phase === 'confirming' || phase === 'submitting') && (
        <PunchConfirmModal
          onClose={() => {
            if (phase === 'submitting') return;
            reset();
          }}
          onConfirm={confirmPunch}
          submitting={phase === 'submitting'}
          {...(preview !== null && { preview })}
        />
      )}

      {phase === 'success' && result && (
        <div style={{ ...card, textAlign: 'center' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              animation: 'memesh-burst 0.5s ease',
            }}
          >
            <Sun size={96} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 12 }}>ניקוב בוצע</div>
          <div style={{ color: MUTED, marginTop: 6 }}>
            נותרו {result.remaining} מתוך {result.total}
          </div>
          <button style={{ ...primaryBtn, width: '100%', marginTop: 18 }} onClick={reset}>
            סריקה הבאה
          </button>
        </div>
      )}

      {phase === 'error' && (
        <div style={{ ...card, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 600, color: '#c25a5a' }}>הניקוב לא בוצע</div>
          <div style={{ color: MUTED, marginTop: 8, fontSize: 14, whiteSpace: 'pre-wrap' }}>
            {punchErrorMsg ?? 'שגיאה לא ידועה.'}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button style={{ ...ghostBtn, flex: 1 }} onClick={() => setPhase('serial')}>
              מספר סידורי
            </button>
            <button style={{ ...primaryBtn, flex: 1 }} onClick={reset}>
              סריקה חוזרת
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SellerPinModal — prompts the cashier for their attribution PIN before a
// sale completes. The cached PIN lives in module memory (sellerPinCache);
// this modal only opens when the cache has no entry for the current user.
// ---------------------------------------------------------------------------

function SellerPinModal({
  firstName,
  length,
  onCancel,
  onConfirm,
}: {
  firstName: string;
  length: number;
  onCancel: () => void;
  onConfirm: (pin: string) => void;
}) {
  const [pin, setPin] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const submit = () => {
    if (pin.length === length) onConfirm(pin);
  };
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(45,52,54,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 16,
          boxShadow: SHADOW,
          padding: 24,
          width: 380,
          maxWidth: '100%',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, color: INK }}>
          היי {firstName}, הזן את הקוד האישי שלך
        </div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 8 }}>
          הקוד יישמר בדפדפן זה למשך זמן הזיכרון שהוגדר. ניתן לאפס בכפתור "החלף קופאי".
        </div>
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, length))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          maxLength={length}
          placeholder={'•'.repeat(length)}
          style={{
            width: '100%',
            fontSize: 32,
            textAlign: 'center',
            letterSpacing: 14,
            padding: '14px 0',
            margin: '18px 0',
            border: '1.5px solid #e9e0d9',
            borderRadius: 10,
            background: '#faf7f3',
            outline: 'none',
            fontFamily: 'ui-monospace, monospace',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={onCancel} style={{ ...ghostBtn, flex: 1 }}>
            ביטול
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pin.length !== length}
            style={{
              ...primaryBtn,
              flex: 1,
              opacity: pin.length === length ? 1 : 0.6,
              cursor: pin.length === length ? 'pointer' : 'not-allowed',
            }}
          >
            המשך
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SelfPinModal — cashier sets or changes their own PIN. The server requires
// the current password as a fresh-auth gate so a stolen session can't
// silently rotate the PIN. Shows current PIN status before the form.
// ---------------------------------------------------------------------------

function SelfPinModal({ length, onClose }: { length: number; onClose: () => void }) {
  const [status, setStatus] = useState<{ exists: boolean; locked: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getMyPinStatus();
      if (cancelled) return;
      if (res.ok) setStatus({ exists: res.data.exists, locked: res.data.locked });
      else setLoadError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    setError(null);
    setSuccess(false);
    if (!/^\d+$/.test(pin) || pin.length !== length) {
      setError(`הקוד חייב להיות בדיוק ${length} ספרות.`);
      return;
    }
    if (password.length === 0) {
      setError('הזן את סיסמת המשתמש שלך כדי לאשר.');
      return;
    }
    setSubmitting(true);
    console.info('[pos self-pin] submit');
    const res = await setMyPin(pin, password);
    setSubmitting(false);
    if (!res.ok) {
      console.warn('[pos self-pin] failed', { error: res.error });
      if (res.error === 'invalid_password') {
        setError('סיסמה שגויה.');
      } else if (res.error === 'pin_wrong_length') {
        setError(`הקוד חייב להיות בדיוק ${length} ספרות לפי ההגדרות.`);
      } else if (res.error === 'invalid_body') {
        setError('הקוד צריך להכיל ספרות בלבד.');
      } else {
        setError('תקלה זמנית. נסו שוב.');
      }
      return;
    }
    console.info('[pos self-pin] success');
    setSuccess(true);
    setPin('');
    setPassword('');
    setStatus({ exists: true, locked: false });
    // Note: we intentionally do NOT cache the freshly-set PIN here — the
    // user already knows it and the next sale will prompt once, which
    // doubles as a confirmation that they entered the right code.
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(45,52,54,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 16,
          boxShadow: SHADOW,
          padding: 24,
          width: 420,
          maxWidth: '100%',
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, color: INK }}>הקוד האישי שלי</div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 6, marginBottom: 14 }}>
          הקוד מצורף לכל מכירה ומאפשר לזהות מי מכר כל כרטיסייה. אורך הקוד: {length} ספרות.
        </div>
        {loadError && (
          <div style={{ color: '#a23a3a', fontSize: 13, marginBottom: 12 }}>
            לא ניתן לטעון את סטטוס הקוד הנוכחי.
          </div>
        )}
        {status && (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: status.exists ? '#f0f7f1' : '#faf7f3',
              border: '1px solid #e9e0d9',
              fontSize: 13.5,
              color: status.exists ? '#3a7d5a' : MUTED,
              marginBottom: 14,
            }}
          >
            {status.locked
              ? 'הקוד נעול לאחר מספר ניסיונות שגויים. פנה למנהל לשחרור.'
              : status.exists
                ? 'מוגדר קוד אישי. ניתן לשנותו כאן.'
                : 'אין קוד מוגדר. כדי למכור כרטיסיות יש להגדיר קוד.'}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 13.5, color: MUTED }}>
            קוד חדש ({length} ספרות)
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, length))}
              maxLength={length}
              disabled={submitting}
              style={{
                width: '100%',
                fontSize: 18,
                padding: '10px 12px',
                marginTop: 4,
                border: '1.5px solid #e9e0d9',
                borderRadius: 10,
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'ui-monospace, monospace',
                letterSpacing: 6,
              }}
            />
          </label>
          <label style={{ fontSize: 13.5, color: MUTED }}>
            סיסמת המשתמש שלך (לאישור)
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              style={{
                width: '100%',
                fontSize: 15,
                padding: '10px 12px',
                marginTop: 4,
                border: '1.5px solid #e9e0d9',
                borderRadius: 10,
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </label>
        </div>
        {error && (
          <div role="alert" style={{ color: '#a23a3a', fontSize: 13.5, marginTop: 10 }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ color: '#3a7d5a', fontSize: 13.5, marginTop: 10 }}>הקוד נשמר.</div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" onClick={onClose} style={{ ...ghostBtn, flex: 1 }}>
            סגירה
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            style={{
              ...primaryBtn,
              flex: 1,
              opacity: submitting ? 0.6 : 1,
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'שומר…' : 'שמירה'}
          </button>
        </div>
      </div>
    </div>
  );
}
