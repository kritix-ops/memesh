import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { type StaffRole } from '../lib/api/auth';
import {
  getDashboardStats,
  getDormantCustomers,
  listStaffActions,
  type DashboardStats,
  type DormantCustomer,
  type StaffActionRow,
  type StaffActionType,
} from '../lib/api/admin';
import {
  cancelCardForAdmin,
  getCardDetail,
  listCardsForAdmin,
  type AdminCardRow,
  type CardDetailResponse,
  type CardListStatus,
} from '../lib/api/cards';
import { getCancelContext, type CancelContext } from '../lib/api/card-settings';
import { Settings } from './settings/Settings';
import {
  createCustomer,
  deleteCustomerById,
  getCustomerDetail,
  searchCustomers,
  type Customer,
  type CustomerDetailResponse,
} from '../lib/api/customers';
import {
  createStaffMember,
  deleteStaffMember,
  listStaff,
  updateStaffMember,
  type CreateStaffInput,
  type StaffMember,
  type UpdateStaffInput,
} from '../lib/api/staff';
import { useStaffSession } from '../lib/staff-session';
import { fmtDate } from '../mock';
import { useViewport } from '../useViewport';

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
const inputStyle: CSSProperties = {
  width: '100%',
  fontSize: 15,
  padding: '11px 14px',
  border: '1.5px solid #e9e0d9',
  borderRadius: 10,
  background: '#fff',
  outline: 'none',
  boxSizing: 'border-box',
};
const primaryBtn: CSSProperties = {
  border: 'none',
  background: ORANGE,
  color: '#fff',
  borderRadius: 10,
  padding: '10px 18px',
  fontWeight: 600,
  cursor: 'pointer',
};
const ghostBtn: CSSProperties = {
  border: '1.5px solid #e9e0d9',
  background: '#fff',
  color: MUTED,
  borderRadius: 10,
  padding: '10px 18px',
  fontWeight: 600,
  cursor: 'pointer',
};

type View = 'dashboard' | 'customers' | 'cards' | 'staff' | 'reports' | 'settings';
// `adminOnly` items are filtered out of the nav for managers (and any other
// non-admin role). The server enforces the same gate; this is UX only.
const NAV: { key: View; label: string; adminOnly?: boolean }[] = [
  { key: 'dashboard', label: 'לוח בקרה' },
  { key: 'customers', label: 'ניהול לקוחות' },
  { key: 'cards', label: 'ניהול כרטיסיות' },
  { key: 'staff', label: 'ניהול צוות' },
  { key: 'reports', label: 'דוחות' },
  { key: 'settings', label: 'הגדרות', adminOnly: true },
];

const roleStyle = (role: StaffRole): { bg: string; color: string; label: string } => {
  if (role === 'admin') return { bg: '#fff4ee', color: '#c97a52', label: 'אדמין' };
  if (role === 'manager') return { bg: '#f0f5e3', color: '#6f8f37', label: 'מנהל משמרת' };
  return { bg: '#f1f2f2', color: MUTED, label: 'קופאי' };
};

const actionLabel = (type: StaffActionType): string => {
  if (type === 'punch') return 'ניקוב כניסה';
  if (type === 'sell_card') return 'מכירת כרטיסייה';
  if (type === 'cancel_card') return 'ביטול כרטיסייה';
  if (type === 'register_customer') return 'רישום לקוח';
  if (type === 'create_staff') return 'הוספת איש צוות';
  if (type === 'update_card_settings') return 'עדכון הגדרות כרטיסייה';
  return 'פעולה';
};

const actionDotColor = (type: StaffActionType): string => {
  if (type === 'sell_card') return '#6f8f37';
  if (type === 'cancel_card') return '#c25a5a';
  if (type === 'punch') return ORANGE;
  return MUTED;
};

const fmtRelative = (iso: string, now = new Date()): string => {
  const t = new Date(iso).getTime();
  const diff = now.getTime() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'לפני רגע';
  if (m < 60) return `לפני ${m} דקות`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} שעות`;
  const d = Math.floor(h / 24);
  if (d < 7) return `לפני ${d} ימים`;
  return fmtDate(iso.slice(0, 10));
};

const fmtIsoDay = (iso: string | null): string => (iso ? fmtDate(iso.slice(0, 10)) : 'אף פעם');

const initialsOf = (first: string, last: string): string => (first[0] ?? '') + (last[0] ?? '');

export function AdminApp() {
  const [view, setView] = useState<View>('dashboard');
  const { width } = useViewport();
  const stacked = width < 1000;
  const { state: navSessionState } = useStaffSession();
  const navRole: StaffRole | null =
    navSessionState.status === 'signed-in' ? navSessionState.user.role : null;
  const visibleNav = NAV.filter((n) => !n.adminOnly || navRole === 'admin');

  return (
    <main
      style={{
        maxWidth: 1140,
        margin: '0 auto',
        padding: stacked ? '16px 14px 56px' : '24px 20px 64px',
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        gap: stacked ? 14 : 20,
      }}
    >
      <nav
        style={
          stacked
            ? {
                display: 'flex',
                gap: 8,
                overflowX: 'auto',
                padding: 6,
                background: '#fff',
                borderRadius: 14,
                boxShadow: SHADOW,
              }
            : { ...card, width: 210, alignSelf: 'flex-start', padding: 10 }
        }
      >
        {visibleNav.map((n) => {
          const on = view === n.key;
          return (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              style={
                stacked
                  ? {
                      flexShrink: 0,
                      border: 'none',
                      cursor: 'pointer',
                      borderRadius: 9,
                      padding: '9px 14px',
                      fontWeight: 600,
                      fontSize: 14,
                      whiteSpace: 'nowrap',
                      background: on ? '#fff4ee' : 'transparent',
                      color: on ? '#c97a52' : MUTED,
                    }
                  : {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      textAlign: 'right',
                      border: 'none',
                      cursor: 'pointer',
                      borderRadius: 10,
                      padding: '11px 12px',
                      fontWeight: 600,
                      fontSize: 14.5,
                      background: on ? '#fff4ee' : 'transparent',
                      color: on ? '#c97a52' : MUTED,
                    }
              }
            >
              {!stacked && (
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: on ? ORANGE : '#dfe3e3',
                  }}
                />
              )}
              {n.label}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1, minWidth: 0 }}>
        {view === 'dashboard' && <Dashboard />}
        {view === 'customers' && <Customers />}
        {view === 'cards' && <Cards />}
        {view === 'staff' && <Staff />}
        {view === 'reports' && <Reports />}
        {view === 'settings' && <Settings />}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [actions, setActions] = useState<StaffActionRow[] | null>(null);
  const [actionsError, setActionsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, a] = await Promise.all([getDashboardStats(), listStaffActions()]);
      if (cancelled) return;
      if (s.ok) setStats(s.data.stats);
      else setStatsError(s.error);
      if (a.ok) setActions(a.data.actions);
      else setActionsError(a.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {stats && stats.expiringIn30d > 0 && (
        <div
          style={{
            ...card,
            background: '#fff4ee',
            boxShadow: 'none',
            border: '1px solid #ffe3d4',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>
              {stats.expiringIn30d} כרטיסיות עומדות לפוג תוקף ב-30 הימים הקרובים
            </div>
            <div style={{ color: MUTED, fontSize: 13.5, marginTop: 2 }}>
              כדאי לשלוח תזכורת ללקוחות לחידוש
            </div>
          </div>
          <span style={{ fontSize: 28, fontWeight: 600, color: '#c97a52' }}>
            {stats.expiringIn30d}
          </span>
        </div>
      )}

      <StatsGrid stats={stats} error={statsError} />

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>פעולות אחרונות</div>
        <ActionList rows={actions} error={actionsError} limit={5} emptyText="אין פעולות עדיין." />
      </div>
    </div>
  );
}

function StatsGrid({ stats, error }: { stats: DashboardStats | null; error: string | null }) {
  if (error) {
    return <div style={{ ...card, color: '#a23a3a' }}>לא ניתן לטעון את הנתונים. רעננו את הדף.</div>;
  }
  if (!stats) {
    return <div style={{ ...card, color: MUTED, textAlign: 'center' }}>טוען נתונים…</div>;
  }
  const cells: { label: string; value: number; tone: string }[] = [
    { label: 'כניסות ב-24 שעות האחרונות', value: stats.entriesLast24h, tone: ORANGE },
    { label: 'כניסות ב-7 הימים האחרונים', value: stats.entriesLast7d, tone: INK },
    { label: 'כניסות ב-30 הימים האחרונים', value: stats.entriesLast30d, tone: INK },
    { label: 'כרטיסיות שנמכרו ב-30 הימים', value: stats.cardsSoldLast30d, tone: INK },
    { label: 'עומדות לפוג תוקף (30 ימים)', value: stats.expiringIn30d, tone: '#c97a52' },
    { label: 'לקוחות חדשים השבוע', value: stats.newCustomersLast7d, tone: INK },
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))',
        gap: 14,
      }}
    >
      {cells.map((c) => (
        <div key={c.label} style={card}>
          <div style={{ fontSize: 30, fontWeight: 600, color: c.tone }}>{c.value}</div>
          <div style={{ fontSize: 13.5, marginTop: 4 }}>{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customers (real search)
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 250;

function Customers() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const q = query.trim();
    const controller = new AbortController();
    // No debounce for the default (empty-query) list — render the recent
    // customers immediately on mount so the operator never lands on a blank
    // screen. Search queries still debounce so we don't fire on every
    // keystroke.
    const fire = async () => {
      setLoading(true);
      setError(null);
      const res = await searchCustomers(q, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setLoading(false);
      if (res.ok) setResults(res.data.results);
      else {
        setError(res.error);
        setResults([]);
      }
    };
    if (q === '') {
      void fire();
      return () => controller.abort();
    }
    const timer = setTimeout(() => void fire(), SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <div style={card}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>ניהול לקוחות</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="חיפוש לפי שם, טלפון או מספר לקוח…"
            style={{ ...inputStyle, minWidth: 240, maxWidth: 360 }}
          />
          <button onClick={() => setShowCreate(true)} style={{ ...primaryBtn, whiteSpace: 'nowrap' }}>
            + הוספת לקוח
          </button>
        </div>
      </div>
      {loading && <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>טוען…</div>}
      {error && (
        <div style={{ color: '#a23a3a', fontSize: 14, padding: '8px 0' }}>
          שגיאה בטעינת הרשימה. נסו שוב.
        </div>
      )}
      {!loading && !error && query.trim() === '' && results.length === 0 && (
        <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>
          אין לקוחות במערכת עדיין. הוסיפו לקוח ראשון בכפתור למעלה.
        </div>
      )}
      {!loading && !error && query.trim() !== '' && results.length === 0 && (
        <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>
          לא נמצאו לקוחות שמתאימים לחיפוש.
        </div>
      )}
      {results.length > 0 && (
        <Table head={['שם', 'מספר לקוח', 'טלפון', 'דוא"ל']}>
          {results.map((c) => (
            <tr
              key={c.id}
              onClick={() => {
                console.info('[web admin customer-detail] open', { id: c.id });
                setDetailFor(c.id);
              }}
              style={{ borderTop: '1px solid #f3efea', cursor: 'pointer' }}
            >
              <Td>{`${c.firstName} ${c.lastName}`}</Td>
              <Td muted>{c.customerNumber}</Td>
              <Td muted>{c.phone}</Td>
              <Td muted>{c.email ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
      {detailFor && (
        <CustomerDetailModal
          customerId={detailFor}
          onClose={() => setDetailFor(null)}
          onDeleted={() => {
            // Re-run the current search by toggling the query through state.
            // Simpler than threading a refresh callback: removing the deleted
            // row from results in place gives instant feedback and avoids a
            // network round-trip the user can verify anyway by re-searching.
            setResults((prev) => prev.filter((c) => c.id !== detailFor));
          }}
        />
      )}
      {showCreate && (
        <CreateCustomerModal
          onClose={() => setShowCreate(false)}
          onCreated={(newCustomer) => {
            setShowCreate(false);
            // Surface the new customer in-place by adding it to the visible
            // results list AND opening its detail modal — saves the operator
            // from typing a search to confirm the create worked.
            setResults((prev) => [newCustomer, ...prev]);
            setDetailFor(newCustomer.id);
          }}
        />
      )}
    </div>
  );
}

function humanizeCustomerCreateError(code: string): string {
  if (code === 'phone_taken') return 'מספר הטלפון כבר רשום במערכת.';
  if (code === 'invalid_body') return 'אחד השדות לא תקין. בדקו ונסו שוב.';
  if (code === 'forbidden') return 'אין לכם הרשאה להוסיף לקוח.';
  return 'לא ניתן לרשום את הלקוח כרגע. נסו שוב בעוד רגע.';
}

function CreateCustomerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
  }>({});

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    const trimmedPhone = phone.trim();
    const trimmedEmail = email.trim();

    const errors: typeof fieldErrors = {};
    if (!trimmedFirst) errors.firstName = 'שדה חובה';
    if (!trimmedLast) errors.lastName = 'שדה חובה';
    if (!trimmedPhone) errors.phone = 'שדה חובה';
    if (trimmedEmail && !/^\S+@\S+\.\S+$/.test(trimmedEmail))
      errors.email = 'כתובת מייל לא תקינה';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setTopError(null);
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setTopError(null);
    const res = await createCustomer({
      firstName: trimmedFirst,
      lastName: trimmedLast,
      phone: trimmedPhone,
      ...(trimmedEmail !== '' && { email: trimmedEmail }),
    });
    setSubmitting(false);

    if (!res.ok) {
      if (res.error === 'phone_taken') {
        setFieldErrors({ phone: 'מספר הטלפון כבר רשום במערכת' });
      } else {
        setTopError(humanizeCustomerCreateError(res.error));
      }
      return;
    }
    onCreated(res.data.customer);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: 24,
          width: 480,
          maxWidth: '100%',
          boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700 }}>הוספת לקוח חדש</div>
          <button
            onClick={onClose}
            aria-label="סגירה"
            style={{
              border: 'none',
              background: 'transparent',
              color: MUTED,
              cursor: 'pointer',
              fontSize: 22,
              padding: '4px 8px',
            }}
          >
            ×
          </button>
        </div>
        {topError && (
          <div
            style={{
              background: '#fdecec',
              color: '#a23a3a',
              padding: '10px 12px',
              borderRadius: 8,
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            {topError}
          </div>
        )}
        <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <FieldRow label="שם פרטי" error={fieldErrors.firstName}>
            <input
              autoFocus
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              disabled={submitting}
              style={inputStyle}
            />
          </FieldRow>
          <FieldRow label="שם משפחה" error={fieldErrors.lastName}>
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              disabled={submitting}
              style={inputStyle}
            />
          </FieldRow>
          <FieldRow label="טלפון" error={fieldErrors.phone}>
            <input
              type="tel"
              placeholder="0541234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
              style={inputStyle}
            />
          </FieldRow>
          <FieldRow label="דוא״ל (אופציונלי)" error={fieldErrors.email}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              style={inputStyle}
            />
          </FieldRow>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                border: '1.5px solid #e9e0d9',
                background: '#fff',
                color: MUTED,
                borderRadius: 8,
                padding: '8px 16px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ביטול
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                ...primaryBtn,
                opacity: submitting ? 0.7 : 1,
                cursor: submitting ? 'wait' : 'pointer',
              }}
            >
              {submitting ? 'מוסיף…' : 'הוספה'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards (mock — backend list endpoint deferred)
// ---------------------------------------------------------------------------

function Cards() {
  const [status, setStatus] = useState<CardListStatus>('active');
  const [rows, setRows] = useState<AdminCardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askCancel, setAskCancel] = useState<AdminCardRow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [detail, setDetail] = useState<CardDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!detailFor) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    (async () => {
      const res = await getCardDetail(detailFor);
      if (cancelled) return;
      setDetailLoading(false);
      if (res.ok) setDetail(res.data);
      else setDetailError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [detailFor]);

  const reload = async () => {
    const res = await listCardsForAdmin({ status });
    if (res.ok) setRows(res.data.cards);
    else setError(res.error);
  };

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    (async () => {
      const res = await listCardsForAdmin({ status });
      if (cancelled) return;
      if (res.ok) setRows(res.data.cards);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  const filters: { k: CardListStatus; l: string }[] = [
    { k: 'active', l: 'פעילות' },
    { k: 'expired', l: 'שפגו' },
    { k: 'cancelled', l: 'בוטלו' },
  ];

  const showActions = status === 'active';
  const head = showActions
    ? ['מספר סידורי', 'לקוח', 'ניצול', 'תוקף', 'סטטוס', '']
    : ['מספר סידורי', 'לקוח', 'ניצול', 'תוקף', 'סטטוס'];

  const confirmCancel = async (reason: string) => {
    if (!askCancel) return;
    setCancelling(true);
    setCancelError(null);
    console.info('[web admin cancel] submit', { id: askCancel.id });
    const res = await cancelCardForAdmin(askCancel.id, reason);
    setCancelling(false);
    if (!res.ok) {
      console.warn('[web admin cancel] error', { status: res.status, error: res.error });
      setCancelError(humanizeCancelError(res.error));
      return;
    }
    console.info('[web admin cancel] success', { id: askCancel.id });
    setAskCancel(null);
    await reload();
  };

  return (
    <div style={card}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>ניהול כרטיסיות</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {filters.map((f) => {
            const on = status === f.k;
            return (
              <button
                key={f.k}
                onClick={() => setStatus(f.k)}
                style={{
                  border: `1.5px solid ${on ? ORANGE : '#e9e0d9'}`,
                  background: on ? '#fff4ee' : '#fff',
                  color: on ? '#c97a52' : MUTED,
                  borderRadius: 10,
                  padding: '8px 16px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {f.l}
              </button>
            );
          })}
        </div>
      </div>
      {error && (
        <div style={{ color: '#a23a3a', fontSize: 14, padding: '8px 0' }}>
          לא ניתן לטעון את רשימת הכרטיסיות. רעננו את הדף.
        </div>
      )}
      {!error && rows === null && (
        <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>טוען…</div>
      )}
      {rows && rows.length === 0 && (
        <div style={{ color: MUTED, fontSize: 14, padding: '12px 0', textAlign: 'center' }}>
          אין כרטיסיות בקטגוריה זו.
        </div>
      )}
      {rows && rows.length > 0 && (
        <Table head={head}>
          {rows.map((c) => {
            const badge = cardStatusBadge(c);
            const customerLabel =
              c.customerFirstName || c.customerLastName
                ? `${c.customerFirstName ?? ''} ${c.customerLastName ?? ''}`.trim()
                : 'לא ידוע';
            return (
              <tr
                key={c.id}
                onClick={() => {
                  console.info('[web admin card-detail] open', { id: c.id });
                  setDetailFor(c.id);
                }}
                style={{ borderTop: '1px solid #f3efea', cursor: 'pointer' }}
              >
                <Td muted>{c.serialNumber}</Td>
                <Td>
                  <div>{customerLabel}</div>
                  {c.customerNumber && (
                    <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                      {c.customerNumber} · {c.customerPhone ?? '—'}
                    </div>
                  )}
                  {c.cancelReason && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color: '#a23a3a',
                        fontStyle: 'italic',
                        marginTop: 4,
                      }}
                    >
                      סיבת ביטול: {c.cancelReason}
                    </div>
                  )}
                </Td>
                <Td muted>
                  {c.usedEntries} / {c.totalEntries}
                </Td>
                <Td muted>{fmtDate(c.expiresAt.slice(0, 10))}</Td>
                <Td>
                  <Badge text={badge.text} bg={badge.bg} color={badge.color} />
                </Td>
                {showActions && (
                  <Td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        console.info('[web admin cancel] open', { id: c.id });
                        setCancelError(null);
                        setAskCancel(c);
                      }}
                      style={{
                        border: '1.5px solid #e8a4a4',
                        background: '#fff',
                        color: '#c25a5a',
                        borderRadius: 8,
                        padding: '6px 12px',
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      ביטול
                    </button>
                  </Td>
                )}
              </tr>
            );
          })}
        </Table>
      )}
      {rows && rows.length === 100 && (
        <div style={{ color: MUTED, fontSize: 12.5, marginTop: 10, textAlign: 'center' }}>
          מוצגות 100 השורות האחרונות בקטגוריה זו.
        </div>
      )}
      {askCancel && (
        <CancelCardModal
          card={askCancel}
          submitting={cancelling}
          error={cancelError}
          onClose={() => {
            if (cancelling) return;
            setAskCancel(null);
            setCancelError(null);
          }}
          onConfirm={confirmCancel}
        />
      )}
      {detailFor && (
        <CardDetailModal
          loading={detailLoading}
          error={detailError}
          detail={detail}
          onClose={() => setDetailFor(null)}
        />
      )}
    </div>
  );
}

function humanizeCancelError(code: string): string {
  if (code === 'not_found') return 'הכרטיסייה לא נמצאה (ייתכן שכבר בוטלה). רעננו את הדף.';
  if (code === 'invalid_body') return 'סיבת הביטול אינה תקינה.';
  if (code === 'invalid_id') return 'מזהה כרטיסייה לא תקין.';
  if (code === 'cancel_blocked_after_punch')
    return 'לא ניתן לבטל כרטיסייה לאחר ניקוב הראשון, לפי ההגדרות.';
  if (code === 'reason_too_short') return 'סיבת הביטול קצרה מדי.';
  if (code === 'forbidden') return 'אין לך הרשאה לבטל כרטיסייה — שאלו את האדמין.';
  return 'תקלה זמנית. נסו שוב בעוד רגע.';
}

function CancelCardModal({
  card,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  card: AdminCardRow;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [context, setContext] = useState<CancelContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getCancelContext();
      if (cancelled) return;
      if (res.ok) setContext(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const trimmed = reason.trim();
  const minLen = context?.minCancelReasonLength ?? 1;
  const reasonTooShort = trimmed.length < minLen;
  const blockedByPunches =
    Boolean(context && !context.allowCancelAfterFirstPunch && card.usedEntries > 0);
  const customerLabel =
    card.customerFirstName || card.customerLastName
      ? `${card.customerFirstName ?? ''} ${card.customerLastName ?? ''}`.trim()
      : 'לקוח לא ידוע';
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(45,52,54,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 50,
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
        <div style={{ fontWeight: 600, fontSize: 18, color: INK }}>ביטול כרטיסייה</div>
        <div style={{ fontSize: 14, color: MUTED, marginTop: 6, marginBottom: 16 }}>
          {card.serialNumber} · {customerLabel}
        </div>
        {context?.refundPolicyText && context.refundPolicyText.trim() !== '' && (
          <div
            style={{
              marginBottom: 14,
              padding: '12px 14px',
              background: '#fff8f3',
              border: '1px solid #ffe3d4',
              borderRadius: 10,
              fontSize: 13,
              color: INK,
              whiteSpace: 'pre-wrap',
            }}
          >
            <div style={{ fontWeight: 600, color: '#a8643d', marginBottom: 4 }}>
              מדיניות החזרים
            </div>
            {context.refundPolicyText}
          </div>
        )}
        {blockedByPunches && (
          <div
            role="alert"
            style={{
              marginBottom: 14,
              padding: '10px 14px',
              background: '#fbecec',
              color: '#a23a3a',
              borderRadius: 10,
              fontSize: 13.5,
              fontWeight: 600,
            }}
          >
            ההגדרות אוסרות ביטול לאחר ניקוב ראשון. השרת ידחה את הבקשה.
          </div>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13.5, color: MUTED }}>
            סיבת ביטול * {minLen > 1 ? `(לפחות ${minLen} תווים)` : ''}
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            rows={3}
            maxLength={500}
            placeholder="לדוגמה: בקשת לקוח, הונפקה בטעות, החזר כספי"
            style={{
              ...inputStyle,
              resize: 'vertical',
              minHeight: 72,
              fontFamily: 'inherit',
            }}
          />
        </label>
        {error && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: '10px 14px',
              background: '#fbecec',
              color: '#a23a3a',
              borderRadius: 10,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button type="button" style={ghostBtn} onClick={onClose} disabled={submitting}>
            ביטול
          </button>
          <button
            type="button"
            onClick={() => onConfirm(trimmed)}
            disabled={submitting || reasonTooShort || blockedByPunches}
            style={{
              border: 'none',
              background: '#c25a5a',
              color: '#fff',
              borderRadius: 10,
              padding: '10px 18px',
              fontWeight: 600,
              cursor:
                submitting || reasonTooShort || blockedByPunches ? 'not-allowed' : 'pointer',
              opacity: submitting || reasonTooShort || blockedByPunches ? 0.6 : 1,
            }}
          >
            {submitting ? 'מבטל…' : 'אישור ביטול'}
          </button>
        </div>
      </div>
    </div>
  );
}

function cardStatusBadge(c: AdminCardRow): { text: string; bg: string; color: string } {
  if (c.cancelledAt) return { text: 'בוטלה', bg: '#fbecec', color: '#c25a5a' };
  if (!c.isActive) return { text: 'לא פעילה', bg: '#ececec', color: '#9aa3a6' };
  return { text: 'פעילה', bg: '#f0f5e3', color: '#6f8f37' };
}

function methodLabel(method: string): string {
  if (method === 'qr_scan') return 'סריקת QR';
  if (method === 'serial') return 'מספר סידורי';
  return method;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${fmtDate(iso.slice(0, 10))} · ${hh}:${mm}`;
}

function CardDetailModal({
  loading,
  error,
  detail,
  onClose,
}: {
  loading: boolean;
  error: string | null;
  detail: CardDetailResponse | null;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(45,52,54,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 16,
          boxShadow: SHADOW,
          padding: 24,
          width: 560,
          maxWidth: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 18, color: INK }}>פרטי כרטיסייה</div>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: MUTED,
              cursor: 'pointer',
              fontSize: 22,
              lineHeight: 1,
              padding: '4px 8px',
            }}
            aria-label="סגירה"
          >
            ×
          </button>
        </div>

        {loading && <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>טוען…</div>}
        {error && (
          <div style={{ color: '#a23a3a', fontSize: 14, padding: '8px 0' }}>
            לא ניתן לטעון את פרטי הכרטיסייה. סגרו וננסו שוב.
          </div>
        )}
        {detail && <CardDetailBody detail={detail} />}
      </div>
    </div>
  );
}

function CardDetailBody({ detail }: { detail: CardDetailResponse }) {
  const { card, entries } = detail;
  const customerLabel =
    card.customerFirstName || card.customerLastName
      ? `${card.customerFirstName ?? ''} ${card.customerLastName ?? ''}`.trim()
      : 'לקוח לא ידוע';
  const badge = cardStatusBadge({
    cancelledAt: card.cancelledAt,
    isActive: card.isActive,
  } as AdminCardRow);
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>{card.serialNumber}</div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
            {customerLabel}
            {card.customerNumber ? ` · ${card.customerNumber}` : ''}
            {card.customerPhone ? ` · ${card.customerPhone}` : ''}
          </div>
        </div>
        <Badge text={badge.text} bg={badge.bg} color={badge.color} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <DetailField label="ניצול">
          {card.usedEntries} / {card.totalEntries}
        </DetailField>
        <DetailField label="הונפקה">{fmtDate(card.createdAt.slice(0, 10))}</DetailField>
        <DetailField label="תוקף עד">{fmtDate(card.expiresAt.slice(0, 10))}</DetailField>
        <DetailField label="מקור">{card.source}</DetailField>
        {card.customerEmail && <DetailField label='דוא"ל'>{card.customerEmail}</DetailField>}
        {card.wcOrderId && <DetailField label="מזהה הזמנה (וקומרס)">{card.wcOrderId}</DetailField>}
      </div>

      {card.cancelledAt && (
        <div
          style={{
            background: '#fbecec',
            border: '1px solid #f3d6d6',
            borderRadius: 10,
            padding: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 600, color: '#c25a5a', fontSize: 14 }}>הכרטיסייה בוטלה</div>
          <div style={{ fontSize: 13, color: '#a23a3a', marginTop: 4 }}>
            {fmtDateTime(card.cancelledAt)}
            {card.cancelReason ? ` · ${card.cancelReason}` : ''}
          </div>
        </div>
      )}

      <div style={{ fontWeight: 600, marginBottom: 10 }}>היסטוריית כניסות ({entries.length})</div>
      {entries.length === 0 ? (
        <div style={{ color: MUTED, fontSize: 14 }}>אין כניסות עדיין.</div>
      ) : (
        entries.map((e, i) => {
          const who =
            e.staffFirstName || e.staffLastName
              ? `${e.staffFirstName ?? ''} ${e.staffLastName ?? ''}`.trim()
              : 'לא ידוע';
          return (
            <div
              key={e.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 0',
                borderTop: i ? '1px solid #f3efea' : 'none',
                fontSize: 14,
              }}
            >
              <div>
                <div>{fmtDateTime(e.punchedAt)}</div>
                <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                  {methodLabel(e.method)} · {who}
                </div>
              </div>
              <div style={{ color: MUTED, whiteSpace: 'nowrap' }}>
                {e.companionCount === 1 ? 'מלווה אחד' : `${e.companionCount} מלווים`}
              </div>
            </div>
          );
        })
      )}
    </>
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, color: INK }}>{children}</div>
    </div>
  );
}

function CustomerDetailModal({
  customerId,
  onClose,
  onDeleted,
}: {
  customerId: string;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [detail, setDetail] = useState<CustomerDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    (async () => {
      const res = await getCustomerDetail(customerId);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setDetail(res.data);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(45,52,54,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 16,
          boxShadow: SHADOW,
          padding: 24,
          width: 600,
          maxWidth: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 18, color: INK }}>פרטי לקוח</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {detail && (
              <button
                onClick={() => setConfirmDelete(true)}
                style={{
                  border: '1.5px solid #f0d6d6',
                  background: '#fff',
                  color: '#a23a3a',
                  borderRadius: 8,
                  padding: '6px 12px',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                מחק
              </button>
            )}
            <button
              onClick={onClose}
              style={{
                border: 'none',
                background: 'transparent',
                color: MUTED,
                cursor: 'pointer',
                fontSize: 22,
                lineHeight: 1,
                padding: '4px 8px',
              }}
              aria-label="סגירה"
            >
              ×
            </button>
          </div>
        </div>
        {loading && <div style={{ color: MUTED, fontSize: 14 }}>טוען…</div>}
        {error && (
          <div style={{ color: '#a23a3a', fontSize: 14 }}>
            לא ניתן לטעון את הלקוח. סגרו ונסו שוב.
          </div>
        )}
        {detail && <CustomerDetailBody detail={detail} />}
      </div>
      {detail && confirmDelete && (
        <DeleteCustomerModal
          customer={detail.customer}
          onClose={() => setConfirmDelete(false)}
          onDeleted={() => {
            setConfirmDelete(false);
            onDeleted?.();
            onClose();
          }}
        />
      )}
    </div>
  );
}

function humanizeCustomerDeleteError(code: string): string {
  if (code === 'has_dependents')
    return 'לא ניתן למחוק — ללקוח יש כרטיסיות בהיסטוריה. בטלו את כל הכרטיסיות לפני המחיקה.';
  if (code === 'not_found') return 'הלקוח לא נמצא. רעננו את הדף.';
  if (code === 'forbidden') return 'רק מנהל או אדמין יכולים למחוק לקוח.';
  return 'תקלה זמנית. נסו שוב בעוד רגע.';
}

function DeleteCustomerModal({
  customer,
  onClose,
  onDeleted,
}: {
  customer: Customer;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    const res = await deleteCustomerById(customer.id);
    if (res.ok) {
      onDeleted();
      return;
    }
    setError(humanizeCustomerDeleteError(res.error));
    setSubmitting(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: 24,
          width: 420,
          maxWidth: '95vw',
          boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>מחיקת לקוח</div>
        <div style={{ color: MUTED, fontSize: 14, marginBottom: 18 }}>
          האם למחוק את <b>{customer.firstName} {customer.lastName}</b> ({customer.phone})? פעולה זו לא ניתנת לביטול.
        </div>
        {error && (
          <div
            style={{
              background: '#fdecec',
              color: '#a23a3a',
              padding: '10px 12px',
              borderRadius: 8,
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              border: '1.5px solid #e9e0d9',
              background: '#fff',
              color: MUTED,
              borderRadius: 8,
              padding: '8px 16px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            style={{
              border: 'none',
              background: '#a23a3a',
              color: '#fff',
              borderRadius: 8,
              padding: '8px 16px',
              fontWeight: 600,
              cursor: submitting ? 'wait' : 'pointer',
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? 'מוחק…' : 'מחק'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CustomerDetailBody({ detail }: { detail: CustomerDetailResponse }) {
  const { customer, cards, entries } = detail;
  const activeCard = cards.find((c) => c.isActive) ?? cards[0];
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: '#fff4ee',
            color: '#c97a52',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
          }}
        >
          {initialsOf(customer.firstName, customer.lastName)}
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {customer.firstName} {customer.lastName}
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
            {customer.customerNumber} · {customer.phone}
            {customer.email ? ` · ${customer.email}` : ''}
          </div>
        </div>
        {customer.marketingConsentAt && <Badge text="הסכמה לדיוור" bg="#f0f5e3" color="#6f8f37" />}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <DetailField label="ערוץ עדיף">{channelLabel(customer.preferredChannel)}</DetailField>
        {customer.source && (
          <DetailField label="איך שמע עלינו">{sourceLabel(customer.source)}</DetailField>
        )}
        <DetailField label="נרשם בתאריך">{fmtDate(customer.createdAt.slice(0, 10))}</DetailField>
        {customer.status !== 'active' && <DetailField label="סטטוס">{customer.status}</DetailField>}
      </div>

      {customer.children.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>ילדים</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {customer.children.map((k) => (
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
                {k.dob ? ` · ${fmtDate(k.dob)}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {customer.internalNotes && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>הערת צוות פנימית</div>
          <div style={{ fontSize: 14, color: MUTED }}>{customer.internalNotes}</div>
        </div>
      )}

      <div style={{ fontWeight: 600, marginBottom: 8 }}>כרטיסיות ({cards.length})</div>
      {cards.length === 0 ? (
        <div style={{ color: MUTED, fontSize: 14, marginBottom: 16 }}>אין כרטיסיות.</div>
      ) : (
        cards.map((c, i) => {
          const status = c.cancelledAt
            ? { text: 'בוטלה', bg: '#fbecec', color: '#c25a5a' }
            : c.isActive
              ? { text: 'פעילה', bg: '#f0f5e3', color: '#6f8f37' }
              : { text: 'לא פעילה', bg: '#ececec', color: '#9aa3a6' };
          return (
            <div
              key={c.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                padding: '8px 0',
                borderTop: i ? '1px solid #f3efea' : 'none',
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{c.serialNumber}</div>
                <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                  {c.usedEntries} / {c.totalEntries} כניסות · תוקף עד{' '}
                  {fmtDate(c.expiresAt.slice(0, 10))}
                </div>
              </div>
              <Badge text={status.text} bg={status.bg} color={status.color} />
            </div>
          );
        })
      )}

      <div style={{ fontWeight: 600, margin: '16px 0 8px' }}>
        כניסות אחרונות ({Math.min(entries.length, 10)} מתוך {entries.length})
      </div>
      {entries.length === 0 ? (
        <div style={{ color: MUTED, fontSize: 14 }}>אין כניסות עדיין.</div>
      ) : (
        entries.slice(0, 10).map((e, i) => (
          <div
            key={e.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '6px 0',
              borderTop: i ? '1px solid #f3efea' : 'none',
              fontSize: 13.5,
            }}
          >
            <span>{fmtDateTime(e.punchedAt)}</span>
            <span style={{ color: MUTED }}>
              {e.companionCount === 1 ? 'מלווה אחד' : `${e.companionCount} מלווים`}
            </span>
          </div>
        ))
      )}
      {activeCard && cards.length > 0 && entries.length === 0 && null}
    </>
  );
}

function channelLabel(c: string): string {
  if (c === 'sms') return 'SMS';
  if (c === 'whatsapp') return 'וואטסאפ';
  if (c === 'email') return 'מייל';
  return c;
}

function sourceLabel(s: string): string {
  if (s === 'referral') return 'חבר/ה';
  if (s === 'social') return 'רשתות חברתיות';
  if (s === 'walk_by') return 'עברתי ברחוב';
  if (s === 'website') return 'אתר אינטרנט';
  if (s === 'other') return 'אחר';
  return s;
}

// ---------------------------------------------------------------------------
// Staff (real list + create form)
// ---------------------------------------------------------------------------

function Staff() {
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [deleting, setDeleting] = useState<StaffMember | null>(null);
  const { state: sessionState } = useStaffSession();
  const currentUserId = sessionState.status === 'signed-in' ? sessionState.user.id : null;

  const reload = async () => {
    const res = await listStaff();
    if (res.ok) setMembers(res.data.staff);
    else setListError(res.error);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listStaff();
      if (cancelled) return;
      if (res.ok) setMembers(res.data.staff);
      else setListError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 18 }}>צוות</div>
          <button
            style={primaryBtn}
            onClick={() => setShowForm((s) => !s)}
            aria-expanded={showForm}
          >
            {showForm ? 'סגירה' : 'הוספת איש צוות'}
          </button>
        </div>
        {showForm && (
          <CreateStaffForm
            onCreated={() => {
              setShowForm(false);
              void reload();
            }}
            onCancel={() => setShowForm(false)}
          />
        )}
        {listError && (
          <div style={{ color: '#a23a3a', fontSize: 14, padding: '8px 0' }}>
            לא ניתן לטעון את רשימת הצוות. רעננו את הדף.
          </div>
        )}
        {!listError && !members && (
          <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>טוען…</div>
        )}
        {members && members.length === 0 && (
          <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>
            עדיין לא הוגדרו אנשי צוות.
          </div>
        )}
        {members?.map((m, i) => {
          const r = roleStyle(m.role);
          const isSelf = m.id === currentUserId;
          return (
            <div
              key={m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 0',
                borderTop: i ? '1px solid #f3efea' : 'none',
                opacity: m.isActive ? 1 : 0.55,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: r.bg,
                  color: r.color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                }}
              >
                {initialsOf(m.firstName, m.lastName)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {m.firstName} {m.lastName}
                  {isSelf && (
                    <span style={{ fontSize: 11, color: MUTED, fontWeight: 400 }}>(אני)</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: MUTED }}>{m.phone}</div>
              </div>
              <Badge text={r.label} bg={r.bg} color={r.color} />
              {!m.isActive && <Badge text="מושעה" bg="#ececec" color="#9aa3a6" />}
              <button
                onClick={() => setEditing(m)}
                style={{
                  border: '1.5px solid #e9e0d9',
                  background: '#fff',
                  color: MUTED,
                  borderRadius: 8,
                  padding: '6px 12px',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                ערוך
              </button>
              <button
                onClick={() => setDeleting(m)}
                disabled={isSelf}
                title={isSelf ? 'לא ניתן למחוק את עצמך' : 'מחיקה'}
                style={{
                  border: '1.5px solid #f0d6d6',
                  background: '#fff',
                  color: isSelf ? '#cfb3b3' : '#a23a3a',
                  borderRadius: 8,
                  padding: '6px 12px',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: isSelf ? 'not-allowed' : 'pointer',
                }}
              >
                מחק
              </button>
            </div>
          );
        })}
      </div>
      {editing && (
        <EditStaffModal
          member={editing}
          isSelf={editing.id === currentUserId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {deleting && (
        <DeleteStaffModal
          member={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function humanizeStaffUpdateError(code: string): string {
  if (code === 'cannot_deactivate_self')
    return 'לא ניתן להשעות את עצמך. בקשו ממנהל אחר לבצע את הפעולה.';
  if (code === 'not_found') return 'איש הצוות לא נמצא. רעננו את הדף.';
  if (code === 'invalid_body') return 'אחד השדות לא תקין.';
  if (code === 'invalid_id') return 'מזהה איש צוות לא תקין.';
  return 'תקלה זמנית. נסו שוב בעוד רגע.';
}

function EditStaffModal({
  member,
  isSelf,
  onClose,
  onSaved,
}: {
  member: StaffMember;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(member.firstName);
  const [lastName, setLastName] = useState(member.lastName);
  const [email, setEmail] = useState(member.email ?? '');
  const [role, setRole] = useState<StaffRole>(member.role);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildPatch = (): UpdateStaffInput => {
    const patch: UpdateStaffInput = {};
    const tf = firstName.trim();
    const tl = lastName.trim();
    const te = email.trim();
    if (tf && tf !== member.firstName) patch.firstName = tf;
    if (tl && tl !== member.lastName) patch.lastName = tl;
    if (role !== member.role) patch.role = role;
    const targetEmail = te === '' ? null : te;
    if (targetEmail !== (member.email ?? null)) patch.email = targetEmail;
    return patch;
  };

  const submit = async (patch: UpdateStaffInput) => {
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    console.info('[web admin staff] update', { id: member.id, fields: Object.keys(patch) });
    const res = await updateStaffMember(member.id, patch);
    setSubmitting(false);
    if (!res.ok) {
      console.warn('[web admin staff] update failed', { error: res.error });
      setError(humanizeStaffUpdateError(res.error));
      return;
    }
    onSaved();
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const tf = firstName.trim();
    const tl = lastName.trim();
    const te = email.trim();
    if (!tf || !tl) {
      setError('שם פרטי ושם משפחה הם שדות חובה.');
      return;
    }
    if (te && !/^\S+@\S+\.\S+$/.test(te)) {
      setError('כתובת מייל לא תקינה.');
      return;
    }
    await submit(buildPatch());
  };

  const onToggleActive = async () => {
    if (member.isActive && isSelf) {
      setError('לא ניתן להשעות את עצמך.');
      return;
    }
    await submit({ isActive: !member.isActive });
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(45,52,54,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 16,
          boxShadow: SHADOW,
          padding: 24,
          width: 480,
          maxWidth: '100%',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 18, color: INK, marginBottom: 6 }}>
          עריכת איש צוות
        </div>
        <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
          {member.phone} · ההצטרפות {fmtDate(member.createdAt.slice(0, 10))}
        </div>
        <form onSubmit={onSave}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))',
              gap: 12,
            }}
          >
            <FieldRow label="שם פרטי *">
              <input
                style={inputStyle}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={submitting}
                autoComplete="given-name"
              />
            </FieldRow>
            <FieldRow label="שם משפחה *">
              <input
                style={inputStyle}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={submitting}
                autoComplete="family-name"
              />
            </FieldRow>
            <FieldRow label="תפקיד">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as StaffRole)}
                disabled={submitting || isSelf}
                style={{ ...inputStyle, paddingInlineEnd: 32 }}
                title={isSelf ? 'לא ניתן לשנות את תפקיד עצמך' : ''}
              >
                <option value="cashier">קופאי</option>
                <option value="manager">מנהל משמרת</option>
                <option value="admin">אדמין</option>
              </select>
            </FieldRow>
            <FieldRow label="מייל">
              <input
                style={inputStyle}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                inputMode="email"
                autoComplete="email"
                disabled={submitting}
              />
            </FieldRow>
          </div>

          {error && (
            <div
              role="alert"
              style={{
                marginTop: 14,
                padding: '10px 14px',
                background: '#fbecec',
                color: '#a23a3a',
                borderRadius: 10,
                fontSize: 14,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: 10,
              marginTop: 18,
              flexWrap: 'wrap',
              justifyContent: 'space-between',
            }}
          >
            <button
              type="button"
              onClick={() => void onToggleActive()}
              disabled={submitting || (member.isActive && isSelf)}
              style={{
                border: member.isActive ? '1.5px solid #e8a4a4' : '1.5px solid #c4d898',
                background: '#fff',
                color: member.isActive ? '#c25a5a' : '#6f8f37',
                borderRadius: 10,
                padding: '10px 18px',
                fontWeight: 600,
                fontSize: 14,
                cursor: submitting || (member.isActive && isSelf) ? 'not-allowed' : 'pointer',
                opacity: submitting || (member.isActive && isSelf) ? 0.5 : 1,
              }}
            >
              {member.isActive ? 'השעיית איש צוות' : 'הפעלת איש צוות'}
            </button>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" style={ghostBtn} onClick={onClose} disabled={submitting}>
                ביטול
              </button>
              <button
                type="submit"
                style={{
                  ...primaryBtn,
                  opacity: submitting ? 0.6 : 1,
                  cursor: submitting ? 'default' : 'pointer',
                }}
                disabled={submitting}
              >
                {submitting ? 'שומר…' : 'שמירה'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function humanizeStaffDeleteError(code: string): string {
  if (code === 'cannot_delete_self')
    return 'לא ניתן למחוק את עצמך. בקשו ממנהל אחר לבצע את הפעולה.';
  if (code === 'cannot_delete_last_admin')
    return 'לא ניתן למחוק את האדמין האחרון. מנו אדמין נוסף לפני המחיקה.';
  if (code === 'has_dependents')
    return 'לא ניתן למחוק — לאיש הצוות יש פעילות בהיסטוריה (לקוחות שנרשמו על שמו, ניקובים, ביטולים). השעו אותו בעריכה במקום זאת.';
  if (code === 'not_found') return 'איש הצוות לא נמצא. רעננו את הדף.';
  return 'תקלה זמנית. נסו שוב בעוד רגע.';
}

function DeleteStaffModal({
  member,
  onClose,
  onDeleted,
}: {
  member: StaffMember;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    const res = await deleteStaffMember(member.id);
    if (res.ok) {
      onDeleted();
      return;
    }
    setError(humanizeStaffDeleteError(res.error));
    setSubmitting(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: 24,
          width: 420,
          maxWidth: '95vw',
          boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>מחיקת איש צוות</div>
        <div style={{ color: MUTED, fontSize: 14, marginBottom: 18 }}>
          האם למחוק את <b>{member.firstName} {member.lastName}</b> ({member.phone})? פעולה זו לא ניתנת לביטול.
        </div>
        {error && (
          <div
            style={{
              background: '#fdecec',
              color: '#a23a3a',
              padding: '10px 12px',
              borderRadius: 8,
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              border: '1.5px solid #e9e0d9',
              background: '#fff',
              color: MUTED,
              borderRadius: 8,
              padding: '8px 16px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            style={{
              border: 'none',
              background: '#a23a3a',
              color: '#fff',
              borderRadius: 8,
              padding: '8px 16px',
              fontWeight: 600,
              cursor: submitting ? 'wait' : 'pointer',
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? 'מוחק…' : 'מחק'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateStaffForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<StaffRole>('cashier');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    firstName?: string;
    lastName?: string;
    phone?: string;
    password?: string;
    email?: string;
  }>({});
  const [topError, setTopError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errors: typeof fieldErrors = {};
    const tFirst = firstName.trim();
    const tLast = lastName.trim();
    const tPhone = phone.trim();
    const tEmail = email.trim();
    if (!tFirst) errors.firstName = 'שדה חובה';
    if (!tLast) errors.lastName = 'שדה חובה';
    if (!tPhone) errors.phone = 'שדה חובה';
    if (password.length < 6) errors.password = 'לפחות 6 תווים';
    if (tEmail && !/^\S+@\S+\.\S+$/.test(tEmail)) errors.email = 'כתובת מייל לא תקינה';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setTopError(null);
      return;
    }
    setSubmitting(true);
    setFieldErrors({});
    setTopError(null);
    const input: CreateStaffInput = {
      firstName: tFirst,
      lastName: tLast,
      phone: tPhone,
      password,
      role,
      ...(tEmail !== '' && { email: tEmail }),
    };
    const res = await createStaffMember(input);
    setSubmitting(false);
    if (!res.ok) {
      if (res.error === 'phone_taken') {
        setFieldErrors({ phone: 'מספר הטלפון כבר רשום במערכת' });
      } else if (res.error === 'invalid_body') {
        setTopError('אחד השדות לא תקין. בדקו ונסו שוב.');
      } else {
        setTopError('לא ניתן להוסיף איש צוות כרגע. נסו שוב.');
      }
      return;
    }
    setFirstName('');
    setLastName('');
    setPhone('');
    setPassword('');
    setEmail('');
    setRole('cashier');
    onCreated();
  };

  return (
    <form
      onSubmit={onSubmit}
      style={{
        background: '#fff8f3',
        border: '1px solid #ffe3d4',
        borderRadius: 12,
        padding: 16,
        marginBottom: 14,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 10 }}>איש צוות חדש</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
          gap: 12,
        }}
      >
        <FieldRow label="שם פרטי *" error={fieldErrors.firstName}>
          <input
            style={errored(inputStyle, fieldErrors.firstName)}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            disabled={submitting}
          />
        </FieldRow>
        <FieldRow label="שם משפחה *" error={fieldErrors.lastName}>
          <input
            style={errored(inputStyle, fieldErrors.lastName)}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            disabled={submitting}
          />
        </FieldRow>
        <FieldRow label="טלפון *" error={fieldErrors.phone}>
          <input
            style={errored(inputStyle, fieldErrors.phone)}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="050-000-0000"
            disabled={submitting}
          />
        </FieldRow>
        <FieldRow label="סיסמה *" error={fieldErrors.password}>
          <input
            style={errored(inputStyle, fieldErrors.password)}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            disabled={submitting}
          />
        </FieldRow>
        <FieldRow label="תפקיד">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as StaffRole)}
            disabled={submitting}
            style={{ ...inputStyle, paddingInlineEnd: 32 }}
          >
            <option value="cashier">קופאי</option>
            <option value="manager">מנהל משמרת</option>
            <option value="admin">אדמין</option>
          </select>
        </FieldRow>
        <FieldRow label="מייל" error={fieldErrors.email}>
          <input
            style={errored(inputStyle, fieldErrors.email)}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            inputMode="email"
            autoComplete="email"
            disabled={submitting}
          />
        </FieldRow>
      </div>
      {topError && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: '#fbecec',
            color: '#a23a3a',
            borderRadius: 10,
            fontSize: 14,
          }}
        >
          {topError}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
        <button type="button" style={ghostBtn} onClick={onCancel} disabled={submitting}>
          ביטול
        </button>
        <button
          type="submit"
          style={{
            ...primaryBtn,
            opacity: submitting ? 0.6 : 1,
            cursor: submitting ? 'default' : 'pointer',
          }}
          disabled={submitting}
        >
          {submitting ? 'שומר…' : 'הוספה'}
        </button>
      </div>
    </form>
  );
}

function errored(base: CSSProperties, error?: string): CSSProperties {
  return error ? { ...base, borderColor: '#e8a4a4' } : base;
}

function FieldRow({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, color: MUTED }}>{label}</span>
      {children}
      {error && <span style={{ fontSize: 12.5, color: '#a23a3a' }}>{error}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Reports (dormant + full action log)
// ---------------------------------------------------------------------------

function Reports() {
  const [dormant, setDormant] = useState<DormantCustomer[] | null>(null);
  const [dormantError, setDormantError] = useState<string | null>(null);
  const [actions, setActions] = useState<StaffActionRow[] | null>(null);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [d, a] = await Promise.all([getDormantCustomers(), listStaffActions()]);
      if (cancelled) return;
      if (d.ok) setDormant(d.data.customers);
      else setDormantError(d.error);
      if (a.ok) setActions(a.data.actions);
      else setActionsError(a.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>לקוחות שלא ביקרו 30+ ימים</div>
        {dormantError && (
          <div style={{ color: '#a23a3a', fontSize: 14 }}>לא ניתן לטעון את הדוח. רעננו את הדף.</div>
        )}
        {!dormantError && !dormant && <div style={{ color: MUTED, fontSize: 14 }}>טוען…</div>}
        {dormant && dormant.length === 0 && (
          <div style={{ color: MUTED, fontSize: 14 }}>
            אין לקוחות רדומים כרגע — כולם פעילים בחודש האחרון.
          </div>
        )}
        {dormant?.map((c, i) => (
          <div
            key={c.id}
            onClick={() => {
              console.info('[web admin customer-detail] open from dormant', { id: c.id });
              setDetailFor(c.id);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 0',
              borderTop: i ? '1px solid #f3efea' : 'none',
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 11,
                background: '#f3f7e8',
                color: '#6f8f37',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 600,
              }}
            >
              {initialsOf(c.firstName, c.lastName)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>
                {c.firstName} {c.lastName}
              </div>
              <div style={{ fontSize: 13, color: MUTED }}>
                {c.customerNumber} · {c.phone}
              </div>
            </div>
            <span style={{ fontSize: 12.5, color: MUTED }}>
              ביקור אחרון: {fmtIsoDay(c.lastVisit)}
            </span>
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>יומן פעולות (50 אחרונות)</div>
        <ActionList rows={actions} error={actionsError} limit={50} emptyText="אין פעולות עדיין." />
      </div>

      {detailFor && (
        <CustomerDetailModal
          customerId={detailFor}
          onClose={() => setDetailFor(null)}
          onDeleted={() => {
            // Drop the deleted customer from the dormant list immediately.
            setDormant((prev) => (prev ? prev.filter((c) => c.id !== detailFor) : prev));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared: action list, table primitives
// ---------------------------------------------------------------------------

function ActionList({
  rows,
  error,
  limit,
  emptyText,
}: {
  rows: StaffActionRow[] | null;
  error: string | null;
  limit: number;
  emptyText: string;
}) {
  if (error) {
    return <div style={{ color: '#a23a3a', fontSize: 14 }}>לא ניתן לטעון את היומן.</div>;
  }
  if (!rows) {
    return <div style={{ color: MUTED, fontSize: 14 }}>טוען…</div>;
  }
  if (rows.length === 0) {
    return <div style={{ color: MUTED, fontSize: 14 }}>{emptyText}</div>;
  }
  return (
    <>
      {rows.slice(0, limit).map((r, i) => {
        const who =
          r.staffFirstName || r.staffLastName
            ? `${r.staffFirstName ?? ''} ${r.staffLastName ?? ''}`.trim()
            : 'מערכת';
        return (
          <div
            key={r.id}
            style={{
              display: 'flex',
              gap: 10,
              padding: '9px 0',
              borderTop: i ? '1px solid #f3efea' : 'none',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: actionDotColor(r.action),
                marginTop: 7,
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14 }}>
                <strong style={{ fontWeight: 600 }}>{who}</strong> · {actionLabel(r.action)}
                {r.summary ? ` · ${r.summary}` : ''}
              </div>
              <div style={{ fontSize: 12.5, color: MUTED }}>{fmtRelative(r.createdAt)}</div>
            </div>
          </div>
        );
      })}
    </>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', minWidth: 440, borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: 'right',
                  color: MUTED,
                  fontWeight: 600,
                  fontSize: 13,
                  padding: '0 0 8px',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <td style={{ padding: '11px 0', color: muted ? MUTED : INK }}>{children}</td>;
}

function Badge({ text, bg, color }: { text: string; bg: string; color: string }) {
  return (
    <span style={{ fontSize: 12.5, background: bg, color, borderRadius: 8, padding: '4px 10px' }}>
      {text}
    </span>
  );
}
