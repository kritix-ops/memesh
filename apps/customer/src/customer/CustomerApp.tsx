import { MemeshQr, PunchCard, Sun } from '@memesh/brand';
import {
  getMyCards,
  updateMe,
  useCustomerSession,
  type CustomerProfile,
} from '@memesh/customer-auth';
import { fmtDate, type PunchCard as ApiPunchCard } from '@memesh/web-shared';
import {
  bookRoundWithPunch,
  cancelRoundBooking,
  getMyRoundBookings,
  getMyWaitlist,
  getRoundAvailability,
  joinWaitlist,
  leaveWaitlist,
  startCompanionCheckout,
  swapRoundBooking,
  type AvailabilityRound,
  type CustomerRoundBooking,
  type CustomerWaitlistEntry,
} from '../lib/api/rounds';
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

// Resend cooldown matches the server's per-phone RESEND_COOLDOWN_MS in
// packages/db/src/otp.ts. Keeping the two in sync client-side prevents the
// SPA from inviting a resend the server would silently swallow.
const RESEND_COOLDOWN_SEC = 60;

const ORANGE = '#ffa983';
const MUTED = '#636e72';
const SHADOW = '0 4px 20px rgba(0,0,0,0.08)';

const card: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 20,
};
// Gift card accent: warm orange border + subtle inner glow makes a gifted
// card visually distinct from a self-purchased one without screaming. The
// gift badge above carries the explanation in words.
const giftCardAccent: CSSProperties = {
  background: 'linear-gradient(180deg, #fff8f1 0%, #ffffff 60%)',
  border: '1.5px solid #ffd9bb',
  boxShadow: '0 8px 28px rgba(246,169,110,0.18)',
};
// Small pill shown ABOVE the punch-card display. "🎁 מתנה מ-{buyer}"
// — warm orange, rounded, deliberately friendly. When buyer name is unknown
// (legacy gift rows or rare data gaps) we drop the "מ-X" tail.
function GiftBadge({ buyerName }: { buyerName: string | null }) {
  return (
    <div
      style={{
        alignSelf: 'stretch',
        background: '#fff4ec',
        border: '1px solid #ffd9bb',
        color: '#a05a23',
        borderRadius: 999,
        padding: '8px 14px',
        fontSize: 14,
        fontWeight: 600,
        textAlign: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <span aria-hidden="true">🎁</span>
      <span>{buyerName ? `מתנה מ-${buyerName}` : 'כרטיסיית מתנה'}</span>
    </div>
  );
}
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
  // Resend cooldown clock. Set when a code goes out; counts down to 0. While
  // > 0 the resend button is disabled and shows the remaining seconds — same
  // contract the server enforces, so the SPA cannot invite a resend that
  // would silently fail with `cooldown`.
  const [resendIn, setResendIn] = useState(0);
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startResendCooldown = useCallback(() => {
    setResendIn(RESEND_COOLDOWN_SEC);
    if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    resendTimerRef.current = setInterval(() => {
      setResendIn((s) => {
        if (s <= 1) {
          if (resendTimerRef.current) clearInterval(resendTimerRef.current);
          resendTimerRef.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    };
  }, []);

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
    startResendCooldown();
  };

  const onResendSms = async () => {
    const trimmed = phone.trim();
    if (!trimmed || resendIn > 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await requestOtp(trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error));
      return;
    }
    setCode('');
    startResendCooldown();
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
    startResendCooldown();
  };

  const onResendEmail = async () => {
    const trimmed = email.trim();
    if (!trimmed || resendIn > 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await requestEmailOtp(trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error));
      return;
    }
    setCode('');
    startResendCooldown();
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
            onClick={() => void onResendSms()}
            disabled={submitting || resendIn > 0}
            style={{
              border: 'none',
              background: 'transparent',
              color: resendIn > 0 ? MUTED : ORANGE,
              cursor: submitting || resendIn > 0 ? 'default' : 'pointer',
              width: '100%',
              marginTop: 12,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {resendIn > 0 ? `שליחת קוד חדש בעוד ${resendIn} שניות` : 'שלחו לי קוד חדש'}
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
              marginTop: 8,
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
            onClick={() => void onResendEmail()}
            disabled={submitting || resendIn > 0}
            style={{
              border: 'none',
              background: 'transparent',
              color: resendIn > 0 ? MUTED : ORANGE,
              cursor: submitting || resendIn > 0 ? 'default' : 'pointer',
              width: '100%',
              marginTop: 12,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {resendIn > 0 ? `שליחת קוד חדש בעוד ${resendIn} שניות` : 'שלחו לי קוד חדש'}
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
              marginTop: 8,
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
  // Surfaces the new server reasons from /verify-otp so a stuck customer
  // sees a real recovery path instead of the catch-all "wrong code" loop.
  if (code === 'invalid_code') return 'הקוד אינו תקין. בדקו שוב את הספרות.';
  if (code === 'code_expired') return 'הקוד פג תוקף. שלחו לעצמכם קוד חדש.';
  if (code === 'code_locked')
    return 'הגעתם למספר ניסיונות מירבי. נסו שוב בעוד כ-15 דקות, או שלחו קוד חדש.';
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
  const [roundBookings, setRoundBookings] = useState<CustomerRoundBooking[] | null>(null);
  const [waitlist, setWaitlist] = useState<CustomerWaitlistEntry[] | null>(null);

  // The customer's active waitlist entries (waiting + notified offers).
  const loadWaitlist = async () => {
    const res = await getMyWaitlist();
    if (res.ok) setWaitlist(res.data.entries);
  };

  // Load /me/cards. The customer cookie was already proven by the parent
  // provider's /me hydration; this just pulls the card list. Kept callable so a
  // punch-card booking can refresh the remaining-entries count.
  const loadCards = async () => {
    const res = await getMyCards();
    if (res.ok) setCards(res.data.cards);
    else setError(res.error);
  };
  useEffect(() => {
    void loadCards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the customer's active/upcoming round bookings. Independent of cards —
  // a failure here just hides the section, it doesn't block the card list.
  // Kept as a callable so a swap can refresh the list.
  const loadRoundBookings = async () => {
    const res = await getMyRoundBookings();
    if (res.ok) setRoundBookings(res.data.bookings);
  };
  useEffect(() => {
    void loadRoundBookings();
    void loadWaitlist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {roundBookings && roundBookings.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>הסבבים שלי</div>
          {roundBookings.map((b) => (
            <RoundBookingCard key={b.bookingId} booking={b} onSwapped={loadRoundBookings} />
          ))}
        </div>
      )}
      {waitlist && waitlist.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>רשימת ההמתנה שלי</div>
          {waitlist.map((w) => (
            <WaitlistEntryCard key={w.entryId} entry={w} onChanged={loadWaitlist} />
          ))}
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
              ...(c.isGift && giftCardAccent),
            }}
          >
            {c.isGift && <GiftBadge buyerName={c.giftBuyerFirstName ?? null} />}
            <PunchCard used={c.usedEntries} total={c.totalEntries} compact />
            <MemeshQr value={c.qrToken} size={180} title={`קוד QR — ${c.serialNumber}`} />
            <div style={{ fontSize: 13, color: MUTED }}>{c.serialNumber}</div>
            <div style={{ fontSize: 13, color: MUTED }}>
              {c.expiresAt === null
                ? 'ללא תפוגה'
                : `תוקף עד ${fmtDate(yyyyMmDd(c.expiresAt))}`}
            </div>
            {c.isActive && c.usedEntries < c.totalEntries && (
              <PunchRoundBooking
                punchCard={c}
                onBooked={async () => {
                  await Promise.all([loadRoundBookings(), loadCards(), loadWaitlist()]);
                }}
                onWaitlisted={loadWaitlist}
              />
            )}
          </div>
        ))}
      </div>
      <button style={primaryBtn} onClick={onEdit}>
        עריכת פרטים
      </button>
    </div>
  );
}

// Book a round using this card's entries (super-brief §3.4). No WooCommerce — the
// customer already paid for the card. Lives inside the punch-card card so the
// "this card → book with it" link is obvious (Yanay feedback, 2026-07-04). Pick a
// day, pick an open round, pick how many entries to spend — a clear "spends N of
// M" confirm precedes the punch so it never happens by accident.
function PunchRoundBooking({
  punchCard,
  onBooked,
  onWaitlisted,
}: {
  punchCard: ApiPunchCard;
  onBooked: () => void | Promise<void>;
  onWaitlisted: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [rounds, setRounds] = useState<AvailabilityRound[] | null>(null);
  const [fullRounds, setFullRounds] = useState<AvailabilityRound[]>([]);
  const [joinMsg, setJoinMsg] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [chosen, setChosen] = useState<AvailabilityRound | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [addCompanion, setAddCompanion] = useState(false);
  const [companionPrice, setCompanionPrice] = useState<number | null>(null);
  const [roundsOff, setRoundsOff] = useState(false);
  // Set when the booking succeeded but the companion payment couldn't start —
  // the done screen tells the customer to retry from the booking card.
  const [companionNote, setCompanionNote] = useState<string | null>(null);

  const remaining = punchCard.totalEntries - punchCard.usedEntries;
  // The stepper can never promise more than the card holds or the round seats.
  const maxCount = chosen ? Math.max(1, Math.min(remaining, chosen.available)) : remaining;

  const primaryBtn: CSSProperties = {
    border: 'none',
    background: '#e7a33e',
    color: '#fff',
    borderRadius: 10,
    padding: '11px 18px',
    fontSize: 14.5,
    fontWeight: 700,
    cursor: 'pointer',
  };
  const ghostBtn: CSSProperties = {
    border: '1.5px solid #e9e0d9',
    background: '#fff',
    color: MUTED,
    borderRadius: 10,
    padding: '11px 18px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  };
  const stepBtn: CSSProperties = {
    ...ghostBtn,
    padding: 0,
    width: 38,
    height: 38,
    fontSize: 20,
    lineHeight: '38px',
  };

  const loadAvailability = async (d: string) => {
    setRounds(null);
    setFullRounds([]);
    setChosen(null);
    setError(null);
    setJoinMsg(null);
    if (!d) return;
    const res = await getRoundAvailability(d);
    if (!res.ok) {
      setError('לא ניתן לטעון זמנים פנויים כרגע.');
      setRounds([]);
      return;
    }
    setRounds(res.data.rounds.filter((r) => r.available > 0 && !r.isClosed));
    setFullRounds(res.data.rounds.filter((r) => r.available === 0 && !r.isClosed));
    setCompanionPrice(res.data.companionPriceIls);
    setRoundsOff(res.data.roundsRequired === false);
  };

  const doJoin = async (r: AvailabilityRound) => {
    setBusy(true);
    setError(null);
    const res = await joinWaitlist(r.roundInstanceId);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error === 'has_availability'
          ? 'יש מקום פנוי — אפשר להזמין ישירות.'
          : 'לא ניתן להצטרף לרשימה כרגע.',
      );
      return;
    }
    setJoinMsg(`נרשמת לרשימת ההמתנה לסבב ${r.startTime}. נודיע לך אם יתפנה מקום.`);
    await onWaitlisted();
  };

  const doBook = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    console.info('[customer punch-booking] booking', {
      roundInstanceId: chosen.roundInstanceId,
      count,
      addCompanion,
    });
    const res = await bookRoundWithPunch(punchCard.id, chosen.roundInstanceId, count);
    if (!res.ok) {
      setBusy(false);
      setError(
        res.error === 'round_full'
          ? 'אין מספיק מקומות פנויים בסבב. בחרו זמן אחר.'
          : res.error === 'not_enough_entries'
            ? 'לא נותרו מספיק כניסות בכרטיסייה.'
            : res.error === 'card_exhausted' || res.error === 'card_inactive'
              ? 'לכרטיסייה לא נותרו כניסות.'
              : res.error === 'card_expired'
                ? 'הכרטיסייה פגה.'
                : 'לא ניתן להזמין כרגע. נסו שוב.',
      );
      return;
    }

    // Companion upsell: the booking stands either way — payment failure only
    // means the extra companion waits for a retry from the booking card. Only
    // offered for a single entry (the checkout attaches to one booking).
    const firstBookingId = res.data.bookings[0]?.bookingId;
    if (addCompanion && count === 1 && firstBookingId) {
      const checkout = await startCompanionCheckout(firstBookingId);
      console.info('[customer companion] checkout result', {
        bookingId: firstBookingId,
        ok: checkout.ok,
        payUrl: checkout.ok ? checkout.data.payUrl : undefined,
        error: checkout.ok ? undefined : checkout.error,
      });
      if (checkout.ok && checkout.data.payUrl) {
        // Off to WC to pay — the paid-order webhook confirms the companion.
        window.location.href = checkout.data.payUrl;
        return;
      }
      if (!checkout.ok || (!checkout.data.confirmed && !checkout.data.alreadyPaid)) {
        setCompanionNote(
          'ההזמנה נקלטה, אבל התשלום עבור המלווה הנוסף לא הושלם. אפשר להשלים אותו מכרטיס ההזמנה למטה.',
        );
      }
    }
    setBusy(false);
    setDone(true);
    await onBooked();
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ ...primaryBtn, width: '100%' }}>
        הזמנת כניסה לסבב
      </button>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        borderTop: '1px solid #f3efea',
        paddingTop: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>הזמנת כניסה לסבב</div>
        <button
          onClick={() => {
            setOpen(false);
            setDone(false);
            setChosen(null);
            setError(null);
          }}
          style={{ border: 'none', background: 'transparent', color: MUTED, fontSize: 13, cursor: 'pointer' }}
        >
          סגירה
        </button>
      </div>

      {done ? (
        <div style={{ textAlign: 'center', fontSize: 14.5, padding: '8px 0' }}>
          <div style={{ color: '#6f8f37' }}>
            {count > 1
              ? 'ההזמנות נקלטו! הברקודים מחכים לך למעלה תחת "הסבבים שלי".'
              : 'ההזמנה נקלטה! הברקוד מחכה לך למעלה תחת "הסבבים שלי".'}
          </div>
          {companionNote && (
            <div style={{ color: '#a8643d', fontSize: 13, marginTop: 8 }}>{companionNote}</div>
          )}
        </div>
      ) : (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: MUTED }}>
            תאריך
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                void loadAvailability(e.target.value);
              }}
              style={{ padding: '10px', borderRadius: 9, border: '1.5px solid #e9e0d9', fontSize: 14 }}
            />
          </label>

          {date && rounds === null && (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 13 }}>טוען…</div>
          )}
          {rounds && rounds.length === 0 && (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 13 }}>
              {roundsOff
                ? 'בתאריך זה הכניסה חופשית — אין צורך בהזמנת סבב, פשוט מגיעים.'
                : 'אין סבבים פנויים ביום זה.'}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rounds?.map((r) => (
              <button
                key={r.roundInstanceId}
                onClick={() => {
                  setChosen(r);
                  setError(null);
                  setCount((c) => Math.min(c, Math.max(1, Math.min(remaining, r.available))));
                }}
                style={{
                  border: `1.5px solid ${chosen?.roundInstanceId === r.roundInstanceId ? '#e7a33e' : '#e9e0d9'}`,
                  background: chosen?.roundInstanceId === r.roundInstanceId ? '#fdf3e3' : '#fff',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontSize: 14,
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {r.label} {r.startTime}–{r.endTime}
                </span>
                <span style={{ color: MUTED, fontSize: 13 }}>{r.available} פנויים</span>
              </button>
            ))}
          </div>

          {fullRounds.length > 0 && (
            <div style={{ borderTop: '1px solid #f3efea', paddingTop: 12 }}>
              <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 8, textAlign: 'center' }}>
                סבבים מלאים — אפשר להירשם לרשימת המתנה
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {fullRounds.map((r) => (
                  <button
                    key={r.roundInstanceId}
                    disabled={busy}
                    onClick={() => void doJoin(r)}
                    style={{
                      border: '1.5px dashed #e2c4c4',
                      background: '#fff',
                      borderRadius: 10,
                      padding: '10px 14px',
                      fontSize: 14,
                      cursor: busy ? 'default' : 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      color: MUTED,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {r.label} {r.startTime}–{r.endTime}
                    </span>
                    <span style={{ fontSize: 13 }}>רשימת המתנה</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {joinMsg && (
            <div style={{ color: '#6f8f37', fontSize: 13, textAlign: 'center' }}>{joinMsg}</div>
          )}

          {chosen && (
            <div style={{ borderTop: '1px solid #f3efea', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {maxCount > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                  <span style={{ fontSize: 13.5 }}>כמה כניסות?</span>
                  <button
                    disabled={busy || count <= 1}
                    onClick={() => setCount((c) => Math.max(1, c - 1))}
                    style={{ ...stepBtn, opacity: count <= 1 ? 0.4 : 1 }}
                  >
                    −
                  </button>
                  <span style={{ fontSize: 18, fontWeight: 700, minWidth: 24, textAlign: 'center' }}>
                    {count}
                  </span>
                  <button
                    disabled={busy || count >= maxCount}
                    onClick={() => setCount((c) => Math.min(maxCount, c + 1))}
                    style={{ ...stepBtn, opacity: count >= maxCount ? 0.4 : 1 }}
                  >
                    +
                  </button>
                </div>
              )}

              <div style={{ fontSize: 13.5, textAlign: 'center' }}>
                {count === 1
                  ? `כניסה לסבב ${chosen.startTime}–${chosen.endTime}. ינוקב כרטיס אחד מתוך ${remaining} שנותרו.`
                  : `${count} כניסות לסבב ${chosen.startTime}–${chosen.endTime}. ינוקבו ${count} כניסות מתוך ${remaining} שנותרו.`}
              </div>

              {count > 1 && (
                <div style={{ fontSize: 12.5, color: MUTED, textAlign: 'center' }}>
                  מלווה אחד כלול בכל כניסה.
                </div>
              )}

              {count === 1 && companionPrice !== null && companionPrice > 0 && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '12px 14px',
                    background: '#fdf8f0',
                    border: '1.5px solid #ecd9b8',
                    borderRadius: 10,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={addCompanion}
                    onChange={(e) => setAddCompanion(e.target.checked)}
                    style={{ marginTop: 3, width: 17, height: 17, cursor: 'pointer' }}
                  />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ fontSize: 14 }}>מלווה נוסף</strong>
                      <strong style={{ fontSize: 14, color: '#a8643d', whiteSpace: 'nowrap' }}>
                        +₪{companionPrice}
                      </strong>
                    </span>
                    <span style={{ display: 'block', fontSize: 12.5, color: MUTED, marginTop: 4 }}>
                      מלווה אחד כלול בכניסה. התשלום מתבצע באתר בסיום ההזמנה.
                    </span>
                  </span>
                </label>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={busy} onClick={() => void doBook()} style={{ ...primaryBtn, flex: 1 }}>
                  {busy
                    ? 'מזמין…'
                    : count === 1 && addCompanion && companionPrice
                      ? `אישור, הזמנה ותשלום ₪${companionPrice}`
                      : 'אישור והזמנה'}
                </button>
                <button disabled={busy} onClick={() => setChosen(null)} style={{ ...ghostBtn, flex: 1 }}>
                  חזרה
                </button>
              </div>
            </div>
          )}

          {error && (
            <div style={{ color: '#a23a3a', fontSize: 13, textAlign: 'center' }}>{error}</div>
          )}
        </>
      )}
    </div>
  );
}

// A waitlist entry: shows whether the customer is still waiting or has an open
// offer to grab (super-brief §8). Claiming an offer is just booking the round
// (now that a seat freed), so the card links to that rather than a special
// action; it also lets the customer leave the list.
function WaitlistEntryCard({
  entry,
  onChanged,
}: {
  entry: CustomerWaitlistEntry;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doLeave = async () => {
    setBusy(true);
    setError(null);
    const res = await leaveWaitlist(entry.entryId);
    setBusy(false);
    if (!res.ok) {
      setError('לא ניתן לצאת מהרשימה כרגע.');
      return;
    }
    await onChanged();
  };

  const notified = entry.status === 'notified';
  const claimTime = entry.claimExpiresAt
    ? new Date(entry.claimExpiresAt).toLocaleTimeString('he-IL', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem',
      })
    : null;

  return (
    <div
      style={{
        ...card,
        marginBottom: 12,
        ...(notified && { border: '1.5px solid #cfe0a8', background: '#f7fbee' }),
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 15 }}>
        {entry.label} · {entry.startTime}–{entry.endTime}
      </div>
      <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{fmtDate(entry.date)}</div>
      {notified ? (
        <div style={{ marginTop: 10, color: '#5f7d2e', fontSize: 13.5, fontWeight: 600 }}>
          התפנה מקום! הזמינו כניסה{claimTime ? ` עד השעה ${claimTime}` : ''} לפני שהמקום יעבור לבא/ה בתור.
        </div>
      ) : (
        <div style={{ marginTop: 10, color: MUTED, fontSize: 13 }}>
          ממתינ/ה ברשימה. נודיע לך ברגע שיתפנה מקום.
        </div>
      )}
      <button
        disabled={busy}
        onClick={() => void doLeave()}
        style={{
          marginTop: 12,
          border: 'none',
          background: 'transparent',
          color: MUTED,
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        יציאה מהרשימה
      </button>
      {error && <div style={{ color: '#a23a3a', fontSize: 13, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// A single round booking with its barcode + a "change time" flow: pick another
// available round on the same day and swap into it (super-brief §6.1).
function RoundBookingCard({
  booking,
  onSwapped,
}: {
  booking: CustomerRoundBooking;
  onSwapped: () => void | Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [alternatives, setAlternatives] = useState<AvailabilityRound[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const secondaryBtn: CSSProperties = {
    border: '1.5px solid #e9e0d9',
    background: '#fff',
    color: MUTED,
    borderRadius: 9,
    padding: '8px 16px',
    fontSize: 13.5,
    fontWeight: 600,
    cursor: 'pointer',
  };
  const dangerBtn: CSSProperties = {
    border: '1.5px solid #e2c4c4',
    background: '#fff',
    color: '#a23a3a',
    borderRadius: 9,
    padding: '8px 16px',
    fontSize: 13.5,
    fontWeight: 600,
    cursor: 'pointer',
  };

  const openPicker = async () => {
    setPicking(true);
    setError(null);
    setAlternatives(null);
    const res = await getRoundAvailability(booking.date);
    if (!res.ok) {
      setError('לא ניתן לטעון זמנים פנויים כרגע.');
      setAlternatives([]);
      return;
    }
    setAlternatives(
      res.data.rounds.filter(
        (r) => r.roundInstanceId !== booking.roundInstanceId && r.available > 0 && !r.isClosed,
      ),
    );
  };

  const doSwap = async (targetRoundInstanceId: string) => {
    setBusy(true);
    setError(null);
    const res = await swapRoundBooking(booking.bookingId, targetRoundInstanceId);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error === 'target_full'
          ? 'הסבב התמלא. בחרו זמן אחר.'
          : res.error === 'too_late'
            ? 'כבר מאוחר מדי לשנות את הזמן.'
            : 'לא ניתן לשנות כרגע. נסו שוב.',
      );
      return;
    }
    setPicking(false);
    await onSwapped();
  };

  const doCompanionPay = async () => {
    setBusy(true);
    setError(null);
    console.info('[customer companion] retry payment', { bookingId: booking.bookingId });
    const res = await startCompanionCheckout(booking.bookingId);
    if (res.ok && res.data.payUrl) {
      window.location.href = res.data.payUrl;
      return;
    }
    setBusy(false);
    if (res.ok && (res.data.alreadyPaid || res.data.confirmed)) {
      // Payment actually went through — the webhook confirms momentarily.
      await onSwapped(); // reloads the bookings list
      return;
    }
    console.warn('[customer companion] retry failed', {
      bookingId: booking.bookingId,
      error: res.ok ? 'no_pay_url' : res.error,
    });
    setError('לא ניתן לפתוח את התשלום כרגע. נסו שוב.');
  };

  const doCancel = async () => {
    setBusy(true);
    setError(null);
    const res = await cancelRoundBooking(booking.bookingId);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error === 'too_late'
          ? 'כבר מאוחר מדי לבטל (אפשר עד 24 שעות לפני הסבב).'
          : res.error === 'refund_failed'
            ? 'הזיכוי לא הושלם. נסו שוב או פנו אלינו.'
            : 'לא ניתן לבטל כרגע. נסו שוב.',
      );
      return;
    }
    // The list reload drops the cancelled booking (it's no longer confirmed).
    setConfirmingCancel(false);
    await onSwapped();
  };

  return (
    <div
      style={{
        ...card,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600 }}>{booking.label}</div>
      <div style={{ fontSize: 13, color: MUTED }}>
        {fmtDate(booking.date)} · {booking.startTime}–{booking.endTime}
      </div>
      {booking.barcodeToken && (
        <MemeshQr value={booking.barcodeToken} size={180} title={`ברקוד — ${booking.label}`} />
      )}
      <div style={{ fontSize: 12.5, color: MUTED }}>
        {booking.ticketType === 'child_under_walking' ? 'תינוק/ת' : 'ילד/ה'}
        {booking.additionalCompanions > 0 ? ' · כולל מלווה נוסף' : ''}
        {booking.status === 'used' ? ' · נוצל' : ''}
      </div>

      {booking.companionPending && booking.status === 'confirmed' && (
        <div
          style={{
            width: '100%',
            padding: '10px 14px',
            background: '#fdf8f0',
            border: '1.5px solid #ecd9b8',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, color: '#a8643d' }}>מלווה נוסף — ממתין לתשלום</span>
          <button
            disabled={busy}
            onClick={() => void doCompanionPay()}
            style={{
              border: 'none',
              background: '#e7a33e',
              color: '#fff',
              borderRadius: 8,
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy ? 'רגע…' : 'השלמת תשלום'}
          </button>
        </div>
      )}

      {booking.status === 'confirmed' && !picking && !confirmingCancel && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button onClick={() => void openPicker()} style={secondaryBtn}>
            שנה שעה
          </button>
          <button
            onClick={() => {
              setConfirmingCancel(true);
              setError(null);
            }}
            style={dangerBtn}
          >
            בטל הזמנה
          </button>
        </div>
      )}

      {confirmingCancel && (
        <div style={{ width: '100%', borderTop: '1px solid #f3efea', paddingTop: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4, textAlign: 'center' }}>
            לבטל את ההזמנה?
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 12, textAlign: 'center' }}>
            {booking.source === 'punchcard'
              ? booking.additionalCompanions > 0
                ? 'הכניסה תוחזר לכרטיסייה שלך, והתשלום עבור המלווה הנוסף יוחזר אוטומטית.'
                : 'הכניסה תוחזר לכרטיסייה שלך.'
              : 'הזיכוי יוחזר אוטומטית לאמצעי התשלום שלכם.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={busy} onClick={() => void doCancel()} style={{ ...dangerBtn, flex: 1 }}>
              {busy ? 'מבטל…' : 'כן, בטלו וזכו אותי'}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setConfirmingCancel(false);
                setError(null);
              }}
              style={{ ...secondaryBtn, flex: 1 }}
            >
              חזרה
            </button>
          </div>
          {error && (
            <div style={{ color: '#a23a3a', fontSize: 13, marginTop: 8, textAlign: 'center' }}>
              {error}
            </div>
          )}
        </div>
      )}

      {picking && (
        <div style={{ width: '100%', borderTop: '1px solid #f3efea', paddingTop: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8, textAlign: 'center' }}>
            בחרו זמן אחר לאותו יום
          </div>
          {alternatives === null && (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 13 }}>טוען…</div>
          )}
          {alternatives && alternatives.length === 0 && (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 13 }}>
              אין זמנים פנויים אחרים היום.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {alternatives?.map((r) => (
              <button
                key={r.roundInstanceId}
                disabled={busy}
                onClick={() => void doSwap(r.roundInstanceId)}
                style={{
                  border: '1.5px solid #e9e0d9',
                  background: '#fff',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontSize: 14,
                  cursor: busy ? 'default' : 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {r.label} {r.startTime}–{r.endTime}
                </span>
                <span style={{ color: MUTED, fontSize: 13 }}>{r.available} פנויים</span>
              </button>
            ))}
          </div>
          {error && (
            <div style={{ color: '#a23a3a', fontSize: 13, marginTop: 8, textAlign: 'center' }}>
              {error}
            </div>
          )}
          <button
            onClick={() => {
              setPicking(false);
              setError(null);
            }}
            disabled={busy}
            style={{
              marginTop: 10,
              border: 'none',
              background: 'transparent',
              color: MUTED,
              fontSize: 13,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            ביטול
          </button>
        </div>
      )}
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
