import { MemeshQr, PunchCard, Sun } from '@memesh/brand';
import {
  getMyCards,
  updateMe,
  useCustomerSession,
  type CustomerProfile,
} from '@memesh/customer-auth';
import { fmtDate, type PunchCard as ApiPunchCard } from '@memesh/web-shared';
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useState } from 'react';

const ORANGE = '#ffa983';
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
const ghostBtn: CSSProperties = {
  background: '#fff',
  color: MUTED,
  border: '1.5px solid #e9e0d9',
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
  boxSizing: 'border-box',
};

const yyyyMmDd = (iso: string): string => iso.slice(0, 10);

const CHANNELS = [
  { k: 'sms', l: 'SMS' },
  { k: 'whatsapp', l: 'וואטסאפ' },
  { k: 'email', l: 'מייל' },
] as const;
type Channel = (typeof CHANNELS)[number]['k'];

const wrap = (children: ReactNode) => (
  <main style={{ maxWidth: 480, margin: '0 auto', padding: '24px 18px 64px' }}>{children}</main>
);

export function CustomerApp() {
  const { state } = useCustomerSession();

  if (state.status === 'loading') {
    return wrap(
      <div style={{ textAlign: 'center', color: MUTED, padding: '48px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <Sun size={48} />
        </div>
        טוען…
      </div>,
    );
  }
  if (state.status === 'signed-out') return wrap(<CustomerLogin />);
  return wrap(<CustomerHome profile={state.profile} />);
}

// ---------------------------------------------------------------------------
// Login (phone -> OTP code)
// ---------------------------------------------------------------------------

function CustomerLogin() {
  const { requestOtp, verifyOtp, requestEmailOtp, verifyEmailOtp } = useCustomerSession();
  const [step, setStep] = useState<'phone' | 'code' | 'email' | 'email-code'>('phone');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRequest = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = phone.trim();
    if (!trimmed) {
      setError('נא להזין מספר טלפון');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await requestOtp(trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error));
      return;
    }
    setCode('');
    setStep('code');
  };

  const onVerify = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError('נא להזין את הקוד');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await verifyOtp(phone.trim(), trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error));
    }
  };

  const onRequestEmail = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !/^\S+@\S+\.\S+$/.test(trimmed)) {
      setError('נא להזין כתובת אימייל תקינה');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await requestEmailOtp(trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error));
      return;
    }
    setCode('');
    setStep('email-code');
  };

  const onVerifyEmail = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError('נא להזין את הקוד מהאימייל');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await verifyEmailOtp(email.trim(), trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error));
    }
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <Sun size={56} />
      </div>
      <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 600 }}>אזור אישי</div>
      {step === 'phone' && (
        <form onSubmit={onRequest}>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 18px' }}>
            הזינו מספר טלפון ונשלח לכם קוד כניסה
          </div>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="050-000-0000"
            disabled={submitting}
            style={{ ...inputStyle, textAlign: 'center' }}
          />
          {error && <ErrorBanner message={error} />}
          <button
            type="submit"
            disabled={submitting}
            style={{
              ...primaryBtn,
              marginTop: 16,
              opacity: submitting ? 0.6 : 1,
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            {submitting ? 'שולח…' : 'שלחו לי קוד'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setError(null);
              setCode('');
            }}
            disabled={submitting}
            style={{
              border: 'none',
              background: 'transparent',
              color: MUTED,
              cursor: 'pointer',
              width: '100%',
              marginTop: 12,
              fontSize: 14,
              textDecoration: 'underline',
            }}
          >
            לא קיבלתי SMS — להתחבר באימייל
          </button>
        </form>
      )}
      {step === 'code' && (
        <form onSubmit={onVerify}>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 4px' }}>
            הזינו את הקוד שנשלח אליכם
          </div>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 13, marginBottom: 18 }}>
            קוד נשלח אל {phone}
          </div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="••••••"
            disabled={submitting}
            style={{
              ...inputStyle,
              textAlign: 'center',
              letterSpacing: 8,
              fontSize: 22,
            }}
          />
          {error && <ErrorBanner message={error} />}
          <button
            type="submit"
            disabled={submitting}
            style={{
              ...primaryBtn,
              marginTop: 16,
              opacity: submitting ? 0.6 : 1,
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            {submitting ? 'מאמת…' : 'כניסה'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('phone');
              setError(null);
              setCode('');
            }}
            disabled={submitting}
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
        </form>
      )}
      {step === 'email' && (
        <form onSubmit={onRequestEmail}>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 18px' }}>
            הזינו את כתובת האימייל שלכם ונשלח לכם קוד כניסה. רק אימייל שכבר רשום במערכת.
          </div>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="your@example.com"
            disabled={submitting}
            style={{ ...inputStyle, textAlign: 'center' }}
          />
          {error && <ErrorBanner message={error} />}
          <button
            type="submit"
            disabled={submitting}
            style={{
              ...primaryBtn,
              marginTop: 16,
              opacity: submitting ? 0.6 : 1,
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            {submitting ? 'שולח…' : 'שלחו לי קוד באימייל'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('phone');
              setError(null);
              setCode('');
            }}
            disabled={submitting}
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
            חזרה להתחברות ב-SMS
          </button>
        </form>
      )}
      {step === 'email-code' && (
        <form onSubmit={onVerifyEmail}>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 4px' }}>
            הזינו את הקוד שנשלח אליכם באימייל
          </div>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 13, marginBottom: 18 }}>
            קוד נשלח אל {email}
          </div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="••••••"
            disabled={submitting}
            style={{
              ...inputStyle,
              textAlign: 'center',
              letterSpacing: 8,
              fontSize: 22,
            }}
          />
          {error && <ErrorBanner message={error} />}
          <button
            type="submit"
            disabled={submitting}
            style={{
              ...primaryBtn,
              marginTop: 16,
              opacity: submitting ? 0.6 : 1,
              cursor: submitting ? 'default' : 'pointer',
            }}
          >
            {submitting ? 'מאמת…' : 'כניסה'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setError(null);
              setCode('');
            }}
            disabled={submitting}
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
            שינוי כתובת האימייל
          </button>
        </form>
      )}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 14,
        padding: '10px 14px',
        background: '#fbecec',
        color: '#a23a3a',
        borderRadius: 10,
        fontSize: 14,
        textAlign: 'center',
      }}
    >
      {message}
    </div>
  );
}

function humanizeCustomerAuthError(code: string): string {
  if (code === 'invalid_code') return 'קוד שגוי או שפג תוקפו. בקשו קוד חדש.';
  if (code === 'invalid_body') return 'הקלט אינו תקין.';
  if (code === 'http_429') return 'יותר מדי ניסיונות. נסו שוב בעוד דקה.';
  return 'תקלה זמנית. נסו שוב בעוד רגע.';
}

// ---------------------------------------------------------------------------
// Signed-in: home (cards + history) and profile edit
// ---------------------------------------------------------------------------

type HomeScreen = 'home' | 'profile';

function CustomerHome({ profile }: { profile: CustomerProfile }) {
  const [screen, setScreen] = useState<HomeScreen>('home');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  if (screen === 'profile') {
    return (
      <ProfileEdit
        profile={profile}
        onSaved={() => {
          setSavedAt(Date.now());
          setScreen('home');
        }}
        onBack={() => setScreen('home')}
      />
    );
  }

  return <Home profile={profile} savedAt={savedAt} onEdit={() => setScreen('profile')} />;
}

function Home({
  profile,
  savedAt,
  onEdit,
}: {
  profile: CustomerProfile;
  savedAt: number | null;
  onEdit: () => void;
}) {
  const { signOut } = useCustomerSession();
  const [cards, setCards] = useState<ApiPunchCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load /me/cards once on mount. The customer cookie was already proven by
  // the parent provider's /me hydration; this just pulls the card list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getMyCards();
      if (cancelled) return;
      if (res.ok) setCards(res.data.cards);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-card diagnostic when the QR actually has a token to render. We log
  // length, not value: enough to confirm the token reached the client, not
  // enough to forge a punch from a console screenshot.
  useEffect(() => {
    if (!cards) return;
    for (const c of cards) {
      console.info('[customer card] qr rendered', {
        serial: c.serialNumber,
        tokenLen: c.qrToken.length,
      });
    }
  }, [cards]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 22, fontWeight: 600 }}>שלום, {profile.firstName}</div>
        <button
          onClick={() => void signOut()}
          style={{
            border: '1.5px solid #e9e0d9',
            background: '#fff',
            color: MUTED,
            borderRadius: 9,
            padding: '6px 12px',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          התנתק
        </button>
      </div>
      {savedAt !== null && (
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
        {error && (
          <div style={{ ...card, color: '#a23a3a', textAlign: 'center' }}>
            לא הצלחנו לטעון את הכרטיסיות. רעננו את הדף.
          </div>
        )}
        {!error && cards === null && (
          <div style={{ ...card, color: MUTED, textAlign: 'center' }}>טוען…</div>
        )}
        {cards && cards.length === 0 && (
          <div style={{ ...card, color: MUTED, textAlign: 'center' }}>אין כרטיסיות פעילות.</div>
        )}
        {cards?.map((c) => (
          <div
            key={c.id}
            style={{
              ...card,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 16,
              marginBottom: 12,
            }}
          >
            <PunchCard used={c.usedEntries} total={c.totalEntries} compact />
            <MemeshQr value={c.qrToken} size={180} title={`קוד QR — ${c.serialNumber}`} />
            <div style={{ fontSize: 13, color: MUTED }}>{c.serialNumber}</div>
            <div style={{ fontSize: 13, color: MUTED }}>
              {c.expiresAt === null
                ? 'ללא תפוגה'
                : `תוקף עד ${fmtDate(yyyyMmDd(c.expiresAt))}`}
            </div>
          </div>
        ))}
      </div>
      <button style={primaryBtn} onClick={onEdit}>
        עריכת פרטים
      </button>
    </div>
  );
}

function ProfileEdit({
  profile,
  onSaved,
  onBack,
}: {
  profile: CustomerProfile;
  onSaved: () => void;
  onBack: () => void;
}) {
  const { setProfile } = useCustomerSession();
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [email, setEmail] = useState(profile.email ?? '');
  const [channel, setChannel] = useState<Channel>(profile.preferredChannel);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
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
    setSubmitting(true);
    setError(null);
    const res = await updateMe({
      firstName: tf,
      lastName: tl,
      ...(te !== '' && { email: te }),
      preferredChannel: channel,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeUpdateError(res.error));
      return;
    }
    setProfile(res.data.profile);
    onSaved();
  };

  return (
    <div>
      <BackButton onClick={onBack} />
      <form onSubmit={onSubmit} style={card}>
        <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>עריכת פרטים</div>
        <Labeled label="שם פרטי">
          <input
            style={inputStyle}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            disabled={submitting}
          />
        </Labeled>
        <Spacer />
        <Labeled label="שם משפחה">
          <input
            style={inputStyle}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            disabled={submitting}
          />
        </Labeled>
        <Spacer />
        <Labeled label="טלפון">
          <input
            value={profile.phone}
            disabled
            style={{ ...inputStyle, background: '#f6f3f0', color: MUTED }}
          />
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
            לא ניתן לשנות טלפון · פנו לצוות
          </div>
        </Labeled>
        <Spacer />
        <Labeled label="מייל">
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            style={inputStyle}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </Labeled>
        <div style={{ margin: '14px 0' }}>
          <div style={{ fontSize: 13.5, color: MUTED, marginBottom: 8 }}>ערוץ עדכונים מועדף</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {CHANNELS.map((ch) => {
              const on = channel === ch.k;
              return (
                <button
                  type="button"
                  key={ch.k}
                  onClick={() => setChannel(ch.k)}
                  disabled={submitting}
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
        {profile.children.length > 0 && (
          <div style={{ margin: '14px 0' }}>
            <div style={{ fontSize: 13.5, color: MUTED, marginBottom: 8 }}>ילדים רשומים</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {profile.children.map((k) => (
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
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              לעריכת רשימת הילדים · פנו לצוות
            </div>
          </div>
        )}
        {error && <ErrorBanner message={error} />}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button
            type="button"
            style={{ ...ghostBtn, flex: 1 }}
            onClick={onBack}
            disabled={submitting}
          >
            ביטול
          </button>
          <button
            type="submit"
            style={{
              ...primaryBtn,
              flex: 1,
              opacity: submitting ? 0.6 : 1,
              cursor: submitting ? 'default' : 'pointer',
            }}
            disabled={submitting}
          >
            {submitting ? 'שומר…' : 'שמירת שינויים'}
          </button>
        </div>
      </form>
    </div>
  );
}

function humanizeUpdateError(code: string): string {
  if (code === 'invalid_body') return 'אחד השדות לא תקין.';
  if (code === 'not_found') return 'הפרופיל לא נמצא. רעננו את הדף.';
  return 'תקלה זמנית. נסו שוב בעוד רגע.';
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13.5, color: MUTED }}>{label}</span>
      {children}
    </label>
  );
}

function Spacer() {
  return <div style={{ height: 14 }} />;
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
