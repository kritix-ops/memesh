import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { FauxQr, PunchCard, Sun } from '../brand';
import {
  avatar,
  companionLabel,
  fmtDate,
  fullName,
  initialCustomers,
  initials,
  type MockCustomer,
  statusBadge,
} from '../mock';

const ORANGE = '#ffa983';
const GREEN = '#c4d898';
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

type Screen = 'home' | 'search' | 'customer' | 'new' | 'sell' | 'scan';
type SellStep = 'choose' | 'confirm' | 'done';
type ScanState = 'camera' | 'success' | 'done' | 'fail';
type Toast = { msg: string; tone: 'ok' | 'green' } | null;

const CARD_PRICE = 320;

export function PosApp() {
  const [customers, setCustomers] = useState<MockCustomer[]>(initialCustomers);
  const [screen, setScreen] = useState<Screen>('home');
  const [selectedId, setSelectedId] = useState<string>(initialCustomers[0]!.id);
  const [query, setQuery] = useState('');
  const [sellStep, setSellStep] = useState<SellStep>('choose');
  const [scanState, setScanState] = useState<ScanState>('camera');
  const [companions, setCompanions] = useState(1);
  const [askCompanions, setAskCompanions] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showToast = (msg: string, tone: 'ok' | 'green' = 'ok') => {
    setToast({ msg, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  const selected = customers.find((c) => c.id === selectedId) ?? customers[0]!;
  const scanned = customers[0]!; // demo card for the scan flow

  const punch = (id: string) => {
    setCustomers((prev) =>
      prev.map((c) => (c.id === id && c.used < c.total ? { ...c, used: c.used + 1 } : c)),
    );
  };

  const openCustomer = (id: string) => {
    setSelectedId(id);
    setScreen('customer');
  };

  const matches = customers.filter((c) => {
    const q = query.trim();
    if (!q) return true;
    return fullName(c).includes(q) || c.phone.includes(q) || c.id.includes(q);
  });

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
      {toast && <ToastView toast={toast} />}
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
          <div style={{ fontSize: 24, fontWeight: 600 }}>בוקר טוב, מליה</div>
          <div style={{ color: MUTED, marginTop: 4 }}>יום שלישי · 17 ביוני 2026</div>
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
          {matches.map((c) => {
            const a = avatar(c);
            const b = statusBadge(c.status);
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
                  {initials(c)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{fullName(c)}</div>
                  <div style={{ fontSize: 13, color: MUTED }}>
                    {c.phone} · {c.id}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 12.5,
                    background: b.bg,
                    color: b.color,
                    borderRadius: 8,
                    padding: '4px 10px',
                  }}
                >
                  {b.text}
                </span>
              </button>
            );
          })}
          {query.trim() && matches.length === 0 && (
            <div style={{ ...card, textAlign: 'center', color: MUTED }}>
              לא נמצאו לקוחות שמתאימים לחיפוש
            </div>
          )}
        </div>
      </div>
    );
  }

  function Customer() {
    const c = selected;
    const a = avatar(c);
    const remaining = c.total - c.used;
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
            {initials(c)}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{fullName(c)}</div>
            <div style={{ fontSize: 14, color: MUTED }}>
              {c.phone} · {c.id}
            </div>
          </div>
        </div>

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
              gap: 18,
            }}
          >
            <PunchCard used={c.used} total={c.total} />
            <button
              onClick={() => {
                setCompanions(1);
                setAskCompanions(true);
              }}
              disabled={remaining <= 0}
              style={{
                ...primaryBtn,
                width: '100%',
                opacity: remaining <= 0 ? 0.5 : 1,
                cursor: remaining <= 0 ? 'default' : 'pointer',
              }}
            >
              ניקוב כניסה
            </button>
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
            <FauxQr seed={c.serial} size={140} />
            <div style={{ fontSize: 13, color: MUTED }}>קוד הכרטיסייה</div>
            <div style={{ fontSize: 13, color: MUTED }}>תוקף עד {fmtDate(c.expiry)}</div>
          </div>
        </div>

        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>היסטוריית כניסות</div>
          {c.history.map((h, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 0',
                borderTop: i ? '1px solid #f3efea' : 'none',
                fontSize: 14,
              }}
            >
              <span>
                {fmtDate(h.date)} · {h.time}
              </span>
              <span style={{ color: MUTED }}>{companionLabel(h.comp)}</span>
            </div>
          ))}
        </div>

        <div style={{ ...card, marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>ילדים</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {c.children.map((k) => (
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
          <div style={{ fontWeight: 600, margin: '14px 0 6px' }}>הערת צוות פנימית</div>
          <div style={{ fontSize: 14, color: MUTED }}>{c.note || 'אין הערות.'}</div>
        </div>

        {askCompanions && (
          <Overlay onClose={() => setAskCompanions(false)}>
            <div style={{ fontSize: 18, fontWeight: 600, textAlign: 'center' }}>כמה מלווים?</div>
            <CompanionStepper />
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button style={{ ...ghostBtn, flex: 1 }} onClick={() => setAskCompanions(false)}>
                ביטול
              </button>
              <button
                style={{ ...primaryBtn, flex: 1 }}
                onClick={() => {
                  punch(c.id);
                  setAskCompanions(false);
                  showToast('ניקוב כניסה בוצע', 'green');
                }}
              >
                נקב כניסה
              </button>
            </div>
          </Overlay>
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

  function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
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
          style={{ ...card, width: 360, maxWidth: '100%', animation: 'memesh-rise 0.25s ease' }}
        >
          {children}
        </div>
      </div>
    );
  }

  function ToastView({ toast: t }: { toast: NonNullable<Toast> }) {
    const bg = t.tone === 'green' ? GREEN : INK;
    const color = t.tone === 'green' ? '#3d4a1f' : '#fff';
    return (
      <div
        style={{
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          background: bg,
          color,
          padding: '12px 22px',
          borderRadius: 12,
          boxShadow: SHADOW,
          animation: 'memesh-toast 0.25s ease',
          zIndex: 60,
        }}
      >
        {t.msg}
      </div>
    );
  }
}
