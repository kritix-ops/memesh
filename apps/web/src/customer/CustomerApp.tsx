import { type CSSProperties, type ReactNode, useState } from 'react';
import { FauxQr, PunchCard, Sun } from '../brand';
import { companionLabel, fmtDate, fullName, initialCustomers } from '../mock';

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
  width: '100%',
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

type Screen = 'login' | 'home' | 'profile';
type LoginStep = 'phone' | 'code';
const CHANNELS = [
  { k: 'sms', l: 'SMS' },
  { k: 'whatsapp', l: 'וואטסאפ' },
  { k: 'email', l: 'מייל' },
] as const;

export function CustomerApp() {
  const me = initialCustomers[0]!;
  const [screen, setScreen] = useState<Screen>('login');
  const [loginStep, setLoginStep] = useState<LoginStep>('phone');
  const [phone, setPhone] = useState('052-3456789');
  const [code, setCode] = useState('');
  const [channel, setChannel] = useState<string>(me.email ? 'whatsapp' : 'sms');
  const [saved, setSaved] = useState(false);

  const wrap = (children: ReactNode) => (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '24px 18px 64px' }}>{children}</main>
  );

  if (screen === 'login') {
    return wrap(
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <Sun size={56} />
        </div>
        <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 600 }}>אזור אישי</div>
        {loginStep === 'phone' ? (
          <>
            <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 18px' }}>
              הזינו מספר טלפון ונשלח לכם קוד כניסה
            </div>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              style={{ ...inputStyle, textAlign: 'center' }}
            />
            <button style={{ ...primaryBtn, marginTop: 16 }} onClick={() => setLoginStep('code')}>
              שלחו לי קוד
            </button>
          </>
        ) : (
          <>
            <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 4px' }}>
              הזינו את הקוד שנשלח אליכם
            </div>
            <div style={{ color: MUTED, textAlign: 'center', fontSize: 13, marginBottom: 18 }}>
              קוד בן 6 ספרות נשלח אל {phone}
            </div>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              placeholder="••••••"
              style={{ ...inputStyle, textAlign: 'center', letterSpacing: 8, fontSize: 22 }}
            />
            <button style={{ ...primaryBtn, marginTop: 16 }} onClick={() => setScreen('home')}>
              כניסה
            </button>
            <button
              onClick={() => setLoginStep('phone')}
              style={{
                border: 'none',
                background: 'transparent',
                color: MUTED,
                cursor: 'pointer',
                width: '100%',
                marginTop: 12,
                fontSize: 14,
              }}
            >
              שינוי מספר טלפון
            </button>
          </>
        )}
      </div>,
    );
  }

  if (screen === 'profile') {
    return wrap(
      <div>
        <BackButton onClick={() => setScreen('home')} />
        <div style={card}>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>עריכת פרטים</div>
          <Field label="שם מלא" defaultValue={fullName(me)} />
          <div style={{ margin: '14px 0' }}>
            <div style={{ fontSize: 13.5, color: MUTED, marginBottom: 6 }}>טלפון</div>
            <input
              value={me.phone}
              disabled
              style={{ ...inputStyle, background: '#f6f3f0', color: MUTED }}
            />
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
              לא ניתן לשנות טלפון · פנו לצוות
            </div>
          </div>
          <Field label="מייל" defaultValue={me.email} />
          <div style={{ margin: '14px 0' }}>
            <div style={{ fontSize: 13.5, color: MUTED, marginBottom: 8 }}>ערוץ עדכונים מועדף</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {CHANNELS.map((ch) => {
                const on = channel === ch.k;
                return (
                  <button
                    key={ch.k}
                    onClick={() => setChannel(ch.k)}
                    style={{
                      flex: 1,
                      border: `1.5px solid ${on ? ORANGE : '#e9e0d9'}`,
                      background: on ? '#fff4ee' : '#fff',
                      color: on ? '#c97a52' : MUTED,
                      borderRadius: 10,
                      padding: '10px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {ch.l}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            style={{ ...primaryBtn, marginTop: 8 }}
            onClick={() => {
              setSaved(true);
              setScreen('home');
            }}
          >
            שמירת שינויים
          </button>
        </div>
      </div>,
    );
  }

  return wrap(
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>שלום, {me.first}</div>
      {saved && (
        <div
          style={{
            ...card,
            background: '#f0f5e3',
            boxShadow: 'none',
            color: '#6f8f37',
            padding: '12px 16px',
          }}
        >
          הפרטים נשמרו
        </div>
      )}
      <div>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>כרטיסיות פעילות</div>
        <div
          style={{
            ...card,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <PunchCard used={me.used} total={me.total} compact />
          <FauxQr seed={me.serial} size={130} />
          <div style={{ fontSize: 13, color: MUTED }}>תוקף עד {fmtDate(me.expiry)}</div>
        </div>
      </div>
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>היסטוריית כניסות</div>
        {me.history.map((h, i) => (
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
      <div style={{ ...card, textAlign: 'center', color: MUTED }}>
        <div style={{ fontWeight: 600, color: INK, marginBottom: 6 }}>כרטיסיות שפגו</div>
        אין כרטיסיות שפגו
      </div>
      <button
        style={primaryBtn}
        onClick={() => {
          setSaved(false);
          setScreen('profile');
        }}
      >
        עריכת פרטים
      </button>
    </div>,
  );

  function Field({ label, defaultValue }: { label: string; defaultValue?: string }) {
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13.5, color: MUTED }}>{label}</span>
        <input defaultValue={defaultValue} style={inputStyle} />
      </label>
    );
  }

  function BackButton({ onClick }: { onClick: () => void }) {
    return (
      <button
        onClick={onClick}
        style={{
          border: 'none',
          background: 'transparent',
          color: MUTED,
          cursor: 'pointer',
          marginBottom: 12,
          fontSize: 15,
        }}
      >
        ← חזרה
      </button>
    );
  }
}
