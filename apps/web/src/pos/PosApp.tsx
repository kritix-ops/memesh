import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { FauxQr, PunchCard, Sun } from '../brand';
import {
  getCustomerDetail,
  searchCustomers,
  type Customer,
  type CustomerDetailResponse,
  type PunchCard as ApiPunchCard,
} from '../lib/api/customers';
import { punchBySerial } from '../lib/api/punch';
import { useStaffSession } from '../lib/staff-session';
import { companionLabel, fmtDate, fullName, initialCustomers, type MockCustomer } from '../mock';
import { PunchConfirmModal } from './PunchConfirmModal';

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

type Screen = 'home' | 'search' | 'customer' | 'new' | 'sell' | 'scan';
type SellStep = 'choose' | 'confirm' | 'done';
type ScanState = 'camera' | 'success' | 'done' | 'fail';

const CARD_PRICE = 320;

export function PosApp() {
  const { state: sessionState } = useStaffSession();
  // The session is guaranteed signed-in here (App.tsx gates this surface), but
  // the discriminated union still needs narrowing for type safety.
  const sessionUser = sessionState.status === 'signed-in' ? sessionState.user : null;

  // Mock state kept for Scan/Sell/NewCustomer flows still on mock data. Search
  // + Customer detail consume the LIVE state below instead.
  const [customers, setCustomers] = useState<MockCustomer[]>(initialCustomers);
  const [screen, setScreen] = useState<Screen>('home');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sellStep, setSellStep] = useState<SellStep>('choose');
  const [scanState, setScanState] = useState<ScanState>('camera');
  const [companions, setCompanions] = useState(1);

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

  // Open the companion-count modal. A fresh UUID lives for this intent only.
  const openPunch = () => {
    setPunchKey(crypto.randomUUID());
    setAskPunch(true);
    setPunchStatus(null);
    console.info('[web punch] open');
  };

  // The actual call. Closes the modal, posts to the API, refetches detail on
  // success, surfaces a Hebrew error otherwise.
  const confirmPunch = async (companionsArg: number) => {
    if (!detail) return;
    const active = pickActiveCard(detail.cards);
    if (!active) return;
    setPunching(true);
    console.info('[web punch] submit', { companions: companionsArg });
    const res = await punchBySerial(active.serialNumber, {
      companions: companionsArg,
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

  // Demo customer used by the Scan flow (still on mock data). The real Scan
  // wiring lands in a follow-up chunk together with POST /punch.
  const scanned = customers[0]!;

  // Mock punch used only by Scan/Customer-overlay flows still on mock data.
  // The real Customer detail screen below disables its punch button until
  // POST /punch is wired.
  const punch = (id: string) => {
    setCustomers((prev) =>
      prev.map((c) => (c.id === id && c.used < c.total ? { ...c, used: c.used + 1 } : c)),
    );
  };

  const openCustomer = (id: string) => {
    setSelectedId(id);
    setScreen('customer');
  };

  return (
    <>
      <main style={{ maxWidth: 920, margin: '0 auto', padding: '24px 20px 64px' }}>
        {screen === 'home' && <Home />}
        {screen === 'search' && <Search />}
        {screen === 'customer' && <Customer />}
        {screen === 'new' && <NewCustomer />}
        {screen === 'sell' && <Sell />}
        {screen === 'scan' && <Scan />}
      </main>
    </>
  );

  function BackBar({ label, to }: { label: string; to: Screen }) {
    return (
      <button
        onClick={() => setScreen(to)}
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
        onClick: () => {
          setScanState('camera');
          setCompanions(1);
          setScreen('scan');
        },
      },
    ];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>
            {greetingFor(new Date())}
            {sessionUser ? `, ${sessionUser.firstName}` : ''}
          </div>
          <div style={{ color: MUTED, marginTop: 4 }}>{hebrewDate(new Date())}</div>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Stat label="כניסות היום" value="38" />
          <Stat label="כרטיסיות שנמכרו היום" value="5" />
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

  function Stat({ label, value }: { label: string; value: string }) {
    return (
      <div style={{ ...card, padding: '14px 22px', minWidth: 150 }}>
        <div style={{ fontSize: 30, fontWeight: 600, color: ORANGE }}>{value}</div>
        <div style={{ fontSize: 13.5, color: MUTED, marginTop: 2 }}>{label}</div>
      </div>
    );
  }

  function Search() {
    const q = query.trim();
    const showEmpty = q.length > 0 && !searchLoading && !searchError && searchResults.length === 0;
    return (
      <div>
        <BackBar label="חזרה" to="home" />
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
          <BackBar label="חזרה לחיפוש" to="search" />
          <div style={{ ...card, textAlign: 'center', color: MUTED }}>טוען פרטי לקוח…</div>
        </div>
      );
    }
    if (detailError || !detail) {
      return (
        <div>
          <BackBar label="חזרה לחיפוש" to="search" />
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
        <BackBar label="חזרה לחיפוש" to="search" />
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
              <FauxQr seed={activeCard.serialNumber} size={140} />
              <div style={{ fontSize: 13, color: MUTED }}>{activeCard.serialNumber}</div>
              <div style={{ fontSize: 13, color: MUTED }}>
                תוקף עד {fmtDate(yyyyMmDd(activeCard.expiresAt))}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ ...card, textAlign: 'center', color: MUTED }}>
            ללקוח אין כרטיסייה פעילה. ניתן למכור כרטיסייה חדשה (זרימת מכירה תחובר בעדכון הבא).
          </div>
        )}

        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>היסטוריית כניסות</div>
          {entries.length === 0 && (
            <div style={{ color: MUTED, fontSize: 14 }}>אין כניסות עדיין.</div>
          )}
          {entries.map((h, i) => (
            <div
              key={h.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 0',
                borderTop: i ? '1px solid #f3efea' : 'none',
                fontSize: 14,
              }}
            >
              <span>
                {fmtDate(yyyyMmDd(h.punchedAt))} · {hhMm(h.punchedAt)}
              </span>
              <span style={{ color: MUTED }}>{companionLabel(h.companionCount)}</span>
            </div>
          ))}
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
          />
        )}
      </div>
    );
  }

  function CompanionStepper() {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          marginTop: 16,
        }}
      >
        <StepBtn label="−" onClick={() => setCompanions((n) => Math.max(1, n - 1))} />
        <div style={{ textAlign: 'center', minWidth: 90 }}>
          <div style={{ fontSize: 40, fontWeight: 600, color: ORANGE, lineHeight: 1 }}>
            {companions}
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
            {companionLabel(companions)}
          </div>
        </div>
        <StepBtn label="+" onClick={() => setCompanions((n) => Math.min(4, n + 1))} />
      </div>
    );
  }

  function StepBtn({ label, onClick }: { label: string; onClick: () => void }) {
    return (
      <button
        onClick={onClick}
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          border: '1.5px solid #e9e0d9',
          background: '#fff',
          fontSize: 24,
          color: INK,
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    );
  }

  function NewCustomer() {
    return (
      <div>
        <BackBar label="חזרה" to="home" />
        <div style={{ ...card }}>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>לקוח חדש</div>
          <div style={{ color: MUTED, fontSize: 14, marginBottom: 18 }}>
            פרטי הלקוח יישמרו וניתן יהיה למכור כרטיסייה מיד
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
              gap: 14,
            }}
          >
            <Field label="שם פרטי *" />
            <Field label="שם משפחה *" />
            <Field label="טלפון *" />
            <Field label="מייל" />
          </div>
          <button
            style={{ ...primaryBtn, width: '100%', marginTop: 20 }}
            onClick={() => {
              setSellStep('choose');
              setScreen('sell');
            }}
          >
            שמור ומכור כרטיסייה
          </button>
        </div>
      </div>
    );
  }

  function Field({ label }: { label: string }) {
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13.5, color: MUTED }}>{label}</span>
        <input style={inputStyle} />
      </label>
    );
  }

  function Sell() {
    return (
      <div>
        <BackBar label="חזרה" to="home" />
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
              <div style={{ fontWeight: 600, fontSize: 18 }}>כרטיסייה · 12 כניסות</div>
              <div style={{ color: MUTED, fontSize: 14, marginTop: 4 }}>
                משלמים על 10, מקבלים 12 · תקף לשנה
              </div>
              <div style={{ fontSize: 36, fontWeight: 600, color: ORANGE, marginTop: 12 }}>
                ₪{CARD_PRICE}
              </div>
              <div style={{ color: MUTED, fontSize: 13.5, marginTop: 4 }}>
                כל כניסה = ילד אחד + מלווה אחד
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
              ₪{CARD_PRICE}
            </div>
            <div style={{ color: MUTED, fontSize: 14 }}>
              החיוב מתבצע בקופה החיצונית. לאחר אישור התשלום, לחצו "אושר".
            </div>
            <div style={{ fontWeight: 600, margin: '18px 0 10px' }}>הלקוח שולם בקופה?</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={{ ...ghostBtn, flex: 1 }} onClick={() => setSellStep('choose')}>
                ביטול
              </button>
              <button style={{ ...primaryBtn, flex: 1 }} onClick={() => setSellStep('done')}>
                אושר
              </button>
            </div>
          </div>
        )}
        {sellStep === 'done' && (
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
              כרטיסייה חדשה עם קוד QR נוצרה ונשלחה ב-SMS ללקוח
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '18px 0' }}>
              <FauxQr seed="M-20260617-0091" size={140} />
            </div>
            <button style={{ ...primaryBtn, width: '100%' }} onClick={() => setScreen('home')}>
              חזרה למסך הראשי
            </button>
          </div>
        )}
      </div>
    );
  }

  function Scan() {
    const remaining = scanned.total - scanned.used;
    return (
      <div>
        <BackBar label="חזרה" to="home" />
        {scanState === 'camera' && (
          <div style={{ ...card, textAlign: 'center' }}>
            <div
              style={{
                background: INK,
                color: '#fff',
                borderRadius: 16,
                height: 240,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 15,
              }}
            >
              מקמו את קוד ה-QR במסגרת
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              <button
                style={{ ...primaryBtn }}
                onClick={() => {
                  setCompanions(1);
                  setScanState('success');
                }}
              >
                סריקה (הדגמה — סריקה תקינה)
              </button>
              <button style={{ ...ghostBtn }} onClick={() => setScanState('fail')}>
                הדגמת כרטיסייה שפגה
              </button>
            </div>
            <div style={{ color: MUTED, fontSize: 13, marginTop: 14 }}>
              אין סריקה? חיפוש ידני לפי מספר סידורי או טלפון
            </div>
          </div>
        )}
        {scanState === 'success' && (
          <div style={{ ...card, textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Sun size={64} />
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 10 }}>{fullName(scanned)}</div>
            <div style={{ color: MUTED, marginTop: 4 }}>
              כניסות שנותרו · {remaining} מתוך {scanned.total}
            </div>
            <div style={{ fontWeight: 600, marginTop: 18 }}>כמה מלווים?</div>
            <CompanionStepper />
            <button
              style={{ ...primaryBtn, width: '100%', marginTop: 18 }}
              onClick={() => {
                punch(scanned.id);
                setScanState('done');
              }}
            >
              ניקוב
            </button>
          </div>
        )}
        {scanState === 'done' && (
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
              {fullName(scanned)} · נותרו {scanned.total - scanned.used} מתוך {scanned.total}
            </div>
            <button
              style={{ ...primaryBtn, width: '100%', marginTop: 18 }}
              onClick={() => {
                setScanState('camera');
                setCompanions(1);
              }}
            >
              סריקה הבאה
            </button>
          </div>
        )}
        {scanState === 'fail' && (
          <div style={{ ...card, textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: '#c25a5a' }}>
              הכרטיסייה אינה פעילה
            </div>
            <div style={{ color: MUTED, marginTop: 8 }}>
              תוקף הכרטיסייה פג בתאריך 03.04.2026. ניתן למכור כרטיסייה חדשה.
            </div>
            <button
              style={{ ...primaryBtn, width: '100%', marginTop: 18 }}
              onClick={() => setScanState('camera')}
            >
              סריקה חוזרת
            </button>
          </div>
        )}
      </div>
    );
  }
}
