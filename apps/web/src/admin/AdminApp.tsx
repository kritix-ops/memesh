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
import { searchCustomers, type Customer } from '../lib/api/customers';
import {
  createStaffMember,
  listStaff,
  type CreateStaffInput,
  type StaffMember,
} from '../lib/api/staff';
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

type View = 'dashboard' | 'customers' | 'cards' | 'staff' | 'reports';
const NAV: { key: View; label: string }[] = [
  { key: 'dashboard', label: 'לוח בקרה' },
  { key: 'customers', label: 'ניהול לקוחות' },
  { key: 'cards', label: 'ניהול כרטיסיות' },
  { key: 'staff', label: 'ניהול צוות' },
  { key: 'reports', label: 'דוחות' },
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
        {NAV.map((n) => {
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

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
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
    }, SEARCH_DEBOUNCE_MS);
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
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש לפי שם, טלפון או מספר לקוח…"
          style={{ ...inputStyle, minWidth: 240, maxWidth: 360 }}
        />
      </div>
      {query.trim() === '' && (
        <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>
          הזינו טקסט לחיפוש לצפייה ברשימה.
        </div>
      )}
      {loading && <div style={{ color: MUTED, fontSize: 14, padding: '8px 0' }}>מחפש…</div>}
      {error && (
        <div style={{ color: '#a23a3a', fontSize: 14, padding: '8px 0' }}>
          שגיאה בחיפוש. נסו שוב.
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
            <tr key={c.id} style={{ borderTop: '1px solid #f3efea' }}>
              <Td>{`${c.firstName} ${c.lastName}`}</Td>
              <Td muted>{c.customerNumber}</Td>
              <Td muted>{c.phone}</Td>
              <Td muted>{c.email ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
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
  const trimmed = reason.trim();
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
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13.5, color: MUTED }}>סיבת ביטול *</span>
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
            disabled={submitting || trimmed.length === 0}
            style={{
              border: 'none',
              background: '#c25a5a',
              color: '#fff',
              borderRadius: 10,
              padding: '10px 18px',
              fontWeight: 600,
              cursor: submitting || trimmed.length === 0 ? 'not-allowed' : 'pointer',
              opacity: submitting || trimmed.length === 0 ? 0.6 : 1,
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

// ---------------------------------------------------------------------------
// Staff (real list + create form)
// ---------------------------------------------------------------------------

function Staff() {
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

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
          return (
            <div
              key={m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 0',
                borderTop: i ? '1px solid #f3efea' : 'none',
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
                <div style={{ fontWeight: 600 }}>
                  {m.firstName} {m.lastName}
                </div>
                <div style={{ fontSize: 13, color: MUTED }}>{m.phone}</div>
              </div>
              <Badge text={r.label} bg={r.bg} color={r.color} />
            </div>
          );
        })}
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
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 0',
              borderTop: i ? '1px solid #f3efea' : 'none',
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
