import { MemeshQr, PunchCard, Sun } from '@memesh/brand';
import { useContent } from '@memesh/content/react';
import {
  getMyCards,
  updateMe,
  useCustomerSession,
  type CustomerProfile,
} from '@memesh/customer-auth';
import {
  addMonths,
  firstOfMonth,
  fmtDate,
  labelHasTime,
  monthGrid,
  monthLabelHe,
  monthOfIso,
  roundTitle,
  type PunchCard as ApiPunchCard,
} from '@memesh/web-shared';
import {
  bookRoundWithPunch,
  cancelRoundBooking,
  getMyRoundBookings,
  getMyWaitlist,
  getRoundAvailabilityRange,
  joinWaitlist,
  leaveWaitlist,
  startCompanionCheckout,
  swapRoundBooking,
  type AvailabilityRound,
  type CustomerBookingScope,
  type CustomerRoundBooking,
  type CustomerWaitlistEntry,
  type DayAvailability,
} from '../lib/api/rounds';
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
// Design tokens from the customer-area brief (memesh-customer-area-brief.md §3).
const INK = '#2d3436'; // primary text
const BG = '#f5f3f0'; // page ground
const BORDER = '#e0e0e0'; // card / divider lines
const ORANGE_SOFT = '#fff4ef'; // active chip / nav background
const ORANGE_INK = '#c9743f'; // orange text on light (contrast-safe)

/** True below the 768px desktop breakpoint (brief §8) — drives sidebar vs. bottom-nav. */
function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [breakpoint]);
  return isMobile;
}

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
  const { t } = useContent();
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
      <span>
        {buyerName ? t('customer.gift.badgeFrom', { buyer: buyerName }) : t('customer.gift.badge')}
      </span>
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

// Labels live in the content registry (customer.profile.channel*), resolved by
// key at render — this carries only the channel value and its label key.
const CHANNELS = [
  { k: 'sms', labelKey: 'customer.profile.channelSms' },
  { k: 'whatsapp', labelKey: 'customer.profile.channelWhatsapp' },
  { k: 'email', labelKey: 'customer.profile.channelEmail' },
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
  // The signed-in area brings its own full-width shell (sidebar / bottom-nav),
  // so it is NOT wrapped in the narrow centered column used by login/loading.
  return <CustomerHome profile={state.profile} />;
}

// ---------------------------------------------------------------------------
// Login (phone -> OTP code)
// ---------------------------------------------------------------------------

function CustomerLogin() {
  const { t } = useContent();
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
      setError(t('customer.login.errPhone'));
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await requestOtp(trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error, t));
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
      setError(humanizeCustomerAuthError(res.error, t));
      return;
    }
    setCode('');
    startResendCooldown();
  };

  const onVerify = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError(t('customer.login.errCode'));
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await verifyOtp(phone.trim(), trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error, t));
    }
  };

  const onRequestEmail = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !/^\S+@\S+\.\S+$/.test(trimmed)) {
      setError(t('customer.login.errEmail'));
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await requestEmailOtp(trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error, t));
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
      setError(humanizeCustomerAuthError(res.error, t));
      return;
    }
    setCode('');
    startResendCooldown();
  };

  const onVerifyEmail = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError(t('customer.login.errEmailCode'));
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await verifyEmailOtp(email.trim(), trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeCustomerAuthError(res.error, t));
    }
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <Sun size={56} />
      </div>
      <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 600 }}>
        {t('customer.login.title')}
      </div>
      {step === 'phone' && (
        <form onSubmit={onRequest}>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 18px' }}>
            {t('customer.login.phonePrompt')}
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
            {submitting ? 'שולח…' : t('customer.login.sendCode')}
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
            {t('customer.login.useEmail')}
          </button>
        </form>
      )}
      {step === 'code' && (
        <form onSubmit={onVerify}>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 4px' }}>
            {t('customer.login.enterCode')}
          </div>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 13, marginBottom: 18 }}>
            {t('customer.login.codeSentTo', { target: phone })}
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
            {submitting ? 'מאמת…' : t('customer.login.enter')}
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
            {resendIn > 0
              ? t('customer.login.resendIn', { seconds: resendIn })
              : t('customer.login.resend')}
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
            {t('customer.login.changePhone')}
          </button>
        </form>
      )}
      {step === 'email' && (
        <form onSubmit={onRequestEmail}>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 18px' }}>
            {t('customer.login.emailPrompt')}
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
            {submitting ? 'שולח…' : t('customer.login.sendEmailCode')}
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
            {t('customer.login.backToSms')}
          </button>
        </form>
      )}
      {step === 'email-code' && (
        <form onSubmit={onVerifyEmail}>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 14, margin: '6px 0 4px' }}>
            {t('customer.login.enterEmailCode')}
          </div>
          <div style={{ color: MUTED, textAlign: 'center', fontSize: 13, marginBottom: 18 }}>
            {t('customer.login.codeSentTo', { target: email })}
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
            {submitting ? 'מאמת…' : t('customer.login.enter')}
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
            {resendIn > 0
              ? t('customer.login.resendIn', { seconds: resendIn })
              : t('customer.login.resend')}
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
            {t('customer.login.changeEmail')}
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

function humanizeCustomerAuthError(code: string, t: (key: string) => string): string {
  // Surfaces the new server reasons from /verify-otp so a stuck customer
  // sees a real recovery path instead of the catch-all "wrong code" loop.
  if (code === 'invalid_code') return t('customer.login.errInvalidCode');
  if (code === 'code_expired') return t('customer.login.errCodeExpired');
  if (code === 'code_locked') return t('customer.login.errTooMany');
  if (code === 'invalid_body') return t('customer.login.errInvalidBody');
  if (code === 'http_429') return t('customer.login.err429');
  return t('customer.login.errGeneric');
}

// ---------------------------------------------------------------------------
// Signed-in: home (cards + history) and profile edit
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App shell — the signed-in area (brief §2, §8): three screens (הזמנות /
// כרטיסיות / פרופיל) behind a desktop sidebar or a mobile bottom-nav. Data
// (cards, bookings, waitlist) loads once here so the nav can show counts and
// every screen reads the same lists; each screen gets its reload callbacks.
// ---------------------------------------------------------------------------

type Screen = 'bookings' | 'cards' | 'profile';

// Labels live in the content registry (customer.nav.*), resolved by key at
// render — this carries only which screens exist and their order.
const NAV: { key: Screen }[] = [{ key: 'bookings' }, { key: 'cards' }, { key: 'profile' }];

const navItemStyle = (active: boolean): CSSProperties => ({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  textAlign: 'right',
  border: 'none',
  background: active ? ORANGE_SOFT : 'transparent',
  color: active ? ORANGE_INK : INK,
  fontWeight: 600,
  fontSize: 14.5,
  padding: '11px 12px',
  borderRadius: 10,
  cursor: 'pointer',
});

const navCount = (active: boolean): CSSProperties => ({
  fontSize: 12.5,
  fontWeight: 600,
  color: active ? ORANGE_INK : MUTED,
  fontVariantNumeric: 'tabular-nums',
});

const bottomNavStyle: CSSProperties = {
  position: 'fixed',
  insetInline: 0,
  bottom: 0,
  background: '#fff',
  borderTop: `1px solid ${BORDER}`,
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  boxShadow: '0 -2px 12px rgba(0,0,0,0.05)',
  zIndex: 20,
};

const bottomItemStyle = (active: boolean): CSSProperties => ({
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  padding: '10px 0 14px',
  fontSize: 12.5,
  fontWeight: 600,
  color: active ? ORANGE_INK : MUTED,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
  minHeight: 56,
});

function NavCountBadge({ n }: { n: number }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        background: ORANGE_SOFT,
        color: ORANGE_INK,
        borderRadius: 999,
        padding: '0 7px',
        minWidth: 18,
        textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {n}
    </span>
  );
}

function AppShell({
  profile,
  active,
  counts,
  onNavigate,
  onSignOut,
  children,
}: {
  profile: CustomerProfile;
  active: Screen;
  counts: Partial<Record<Screen, number>>;
  onNavigate: (s: Screen) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const { t } = useContent();
  const isMobile = useIsMobile();
  const title = t(`customer.nav.${active}`);

  if (isMobile) {
    return (
      <div
        style={{
          direction: 'rtl',
          minHeight: '100vh',
          background: BG,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '18px 18px 6px',
          }}
        >
          <div style={{ fontSize: 21, fontWeight: 600, color: INK }}>{title}</div>
          <button
            onClick={onSignOut}
            style={{
              border: 'none',
              background: 'transparent',
              color: MUTED,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('customer.nav.signOut')}
          </button>
        </header>
        <main
          style={{
            flex: 1,
            width: '100%',
            maxWidth: 560,
            margin: '0 auto',
            padding: '8px 16px 92px',
            boxSizing: 'border-box',
          }}
        >
          {children}
        </main>
        <nav style={bottomNavStyle}>
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => onNavigate(n.key)}
              style={bottomItemStyle(active === n.key)}
              aria-current={active === n.key ? 'page' : undefined}
            >
              <span>{t(`customer.nav.${n.key}`)}</span>
              {counts[n.key] ? <NavCountBadge n={counts[n.key]!} /> : null}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div style={{ direction: 'rtl', minHeight: '100vh', background: BG }}>
      <div
        style={{
          maxWidth: 860,
          margin: '0 auto',
          display: 'flex',
          gap: 22,
          padding: '32px 24px 64px',
          alignItems: 'flex-start',
        }}
      >
        <aside
          style={{
            ...card,
            width: 176,
            flex: 'none',
            position: 'sticky',
            top: 32,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: 16,
          }}
        >
          <div style={{ marginBottom: 8, padding: '0 4px' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>
              {profile.firstName} {profile.lastName}
            </div>
            <div style={{ fontSize: 12.5, color: MUTED }} dir="ltr">
              {profile.phone}
            </div>
          </div>
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => onNavigate(n.key)}
              style={navItemStyle(active === n.key)}
              aria-current={active === n.key ? 'page' : undefined}
            >
              <span>{t(`customer.nav.${n.key}`)}</span>
              {counts[n.key] ? (
                <span style={navCount(active === n.key)}>{counts[n.key]}</span>
              ) : null}
            </button>
          ))}
          <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 6, paddingTop: 6 }}>
            <button onClick={onSignOut} style={navItemStyle(false)}>
              {t('customer.nav.signOut')}
            </button>
          </div>
        </aside>
        <main style={{ flex: 1, minWidth: 0, maxWidth: 600 }}>{children}</main>
      </div>
    </div>
  );
}

function CustomerHome({ profile }: { profile: CustomerProfile }) {
  const { signOut } = useCustomerSession();
  const [screen, setScreen] = useState<Screen>('bookings');
  const [cards, setCards] = useState<ApiPunchCard[] | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [roundBookings, setRoundBookings] = useState<CustomerRoundBooking[] | null>(null);
  const [waitlist, setWaitlist] = useState<CustomerWaitlistEntry[] | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const loadCards = async () => {
    const res = await getMyCards();
    if (res.ok) setCards(res.data.cards);
    else setCardsError(res.error);
  };
  const loadRoundBookings = async () => {
    const res = await getMyRoundBookings();
    if (res.ok) setRoundBookings(res.data.bookings);
  };
  const loadWaitlist = async () => {
    const res = await getMyWaitlist();
    if (res.ok) setWaitlist(res.data.entries);
  };

  useEffect(() => {
    void loadCards();
    void loadRoundBookings();
    void loadWaitlist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-card diagnostic: log token length (not value) once the list lands.
  useEffect(() => {
    if (!cards) return;
    for (const c of cards) {
      console.info('[customer card] qr rendered', {
        serial: c.serialNumber,
        tokenLen: c.qrToken.length,
      });
    }
  }, [cards]);

  const counts: Partial<Record<Screen, number>> = {
    ...(roundBookings ? { bookings: roundBookings.length } : {}),
    ...(cards ? { cards: cards.length } : {}),
  };

  return (
    <AppShell
      profile={profile}
      active={screen}
      counts={counts}
      onNavigate={(s) => {
        console.info('[customer nav] switch', { to: s });
        setScreen(s);
      }}
      onSignOut={() => void signOut()}
    >
      {screen === 'bookings' && (
        <BookingsScreen
          upcoming={roundBookings}
          waitlist={waitlist}
          onReloadUpcoming={loadRoundBookings}
          onReloadWaitlist={loadWaitlist}
        />
      )}
      {screen === 'cards' && (
        <CardsScreen
          cards={cards}
          bookings={roundBookings}
          error={cardsError}
          onBooked={async () => {
            await Promise.all([loadRoundBookings(), loadCards(), loadWaitlist()]);
          }}
          onWaitlisted={loadWaitlist}
          onGoToBookings={() => {
            console.info('[customer nav] switch', { to: 'bookings', from: 'card-badge' });
            setScreen('bookings');
          }}
        />
      )}
      {screen === 'profile' && (
        <ProfileScreen profile={profile} savedAt={savedAt} onSaved={() => setSavedAt(Date.now())} />
      )}
    </AppShell>
  );
}

// Labels live in the content registry (customer.bookings.scope.* /
// customer.bookings.period.*), resolved by key at render — these carry only
// structure (which scope, which lower bound).
const BOOKING_SCOPES: { key: CustomerBookingScope }[] = [
  { key: 'upcoming' },
  { key: 'past' },
  { key: 'cancelled' },
  { key: 'all' },
];

// Period chips for the history scope (brief §4). null = no lower bound.
const BOOKING_PERIODS: { key: string; days: number | null }[] = [
  { key: 'm1', days: 30 },
  { key: 'm3', days: 90 },
  { key: 'm6', days: 180 },
  { key: 'y1', days: 365 },
  { key: 'all', days: null },
];

/** YYYY-MM-DD `days` before today (local) — the period-chip lower bound. */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// One booking as an accordion row (brief §2/§4): a summary header that expands
// to the full card (QR + actions). The first booking opens by default.
function CollapsibleBooking({
  booking,
  defaultOpen,
  justMoved = false,
  onChanged,
  onMoved,
}: {
  booking: CustomerRoundBooking;
  defaultOpen: boolean;
  /** This booking was just rescheduled — open it, scroll to it, ribbon it. */
  justMoved?: boolean;
  onChanged: () => void | Promise<void>;
  /** Reports a successful reschedule up to the list (with this booking's id). */
  onMoved?: (bookingId: string) => void;
}) {
  const { t } = useContent();
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  // A rescheduled booking re-sorts into its new date slot, so without a
  // visible landing point the swap read as "the card just jumped somewhere"
  // (Yanay 2026-07-10). Pull the customer's eye to where it landed.
  useEffect(() => {
    if (!justMoved) return;
    setOpen(true);
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [justMoved]);
  const pill =
    booking.status === 'cancelled'
      ? { text: t('customer.booking.statusCancelled'), bg: '#f6e7e7', fg: '#a23a3a' }
      : booking.status === 'used'
        ? { text: t('customer.booking.used'), bg: '#eef1f4', fg: MUTED }
        : null;
  const labelHasT = labelHasTime(booking.label);
  return (
    <div
      ref={rootRef}
      style={{
        ...card,
        padding: 0,
        overflow: 'hidden',
        ...(justMoved && { border: '1.5px solid #cfe0a8', background: '#f7fbee' }),
      }}
    >
      <button
        type="button"
        onClick={() => {
          console.info('[customer bookings] toggle card', { open: !open });
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          padding: '14px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'right',
          font: 'inherit',
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: INK }}>{booking.label}</span>
            {!labelHasT && (
              <span style={{ fontSize: 13, color: MUTED }}>
                {booking.startTime}–{booking.endTime}
              </span>
            )}
          </span>
          <span style={{ fontSize: 12.5, color: MUTED }}>{fmtDate(booking.date)}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {pill && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                borderRadius: 999,
                padding: '2px 9px',
                background: pill.bg,
                color: pill.fg,
              }}
            >
              {pill.text}
            </span>
          )}
          <span
            aria-hidden
            style={{
              color: '#c3bdb4',
              fontSize: 15,
              lineHeight: 1,
              transform: open ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s',
            }}
          >
            ⌄
          </span>
        </span>
      </button>
      {open && (
        <div style={{ padding: '6px 16px 18px', borderTop: `1px solid ${BORDER}` }}>
          {justMoved && (
            <div
              style={{
                margin: '8px 0 14px',
                padding: '10px 14px',
                borderRadius: 10,
                background: '#eef4e2',
                color: '#5b7a34',
                fontSize: 13.5,
                fontWeight: 600,
                textAlign: 'center',
              }}
            >
              {t('customer.booking.rescheduleSuccess')}
            </div>
          )}
          <RoundBookingCard
            booking={booking}
            onSwapped={onChanged}
            {...(onMoved ? { onMoved: () => onMoved(booking.bookingId) } : {})}
            compact
          />
        </div>
      )}
    </div>
  );
}

function BookingsScreen({
  upcoming,
  waitlist,
  onReloadUpcoming,
  onReloadWaitlist,
}: {
  upcoming: CustomerRoundBooking[] | null;
  waitlist: CustomerWaitlistEntry[] | null;
  onReloadUpcoming: () => void | Promise<void>;
  onReloadWaitlist: () => void | Promise<void>;
}) {
  const { t } = useContent();
  const [scope, setScope] = useState<CustomerBookingScope>('upcoming');
  const [periodKey, setPeriodKey] = useState('all');
  const [others, setOthers] = useState<CustomerRoundBooking[] | null>(null);
  const [othersError, setOthersError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // The booking that just rescheduled — its card gets the success ribbon and
  // the scroll-to. Cleared after a beat: long enough to read, short enough
  // that the highlight never reads as a permanent status.
  const [movedId, setMovedId] = useState<string | null>(null);
  useEffect(() => {
    if (!movedId) return;
    const t = setTimeout(() => setMovedId(null), 8000);
    return () => clearTimeout(t);
  }, [movedId]);

  const period = BOOKING_PERIODS.find((p) => p.key === periodKey) ?? BOOKING_PERIODS[4]!;
  const sinceIso = scope === 'past' && period.days ? isoDaysAgo(period.days) : undefined;

  // Non-upcoming scopes fetch their own slice; upcoming reuses the parent list.
  useEffect(() => {
    if (scope === 'upcoming') return;
    let cancelled = false;
    setOthers(null);
    setOthersError(false);
    console.info('[customer bookings] fetch', { scope, sinceIso });
    void (async () => {
      const res = await getMyRoundBookings({ scope, ...(sinceIso ? { since: sinceIso } : {}) });
      if (cancelled) return;
      if (res.ok) setOthers(res.data.bookings);
      else setOthersError(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, sinceIso, reloadNonce]);

  const onCardChanged = async () => {
    await onReloadUpcoming();
    if (scope !== 'upcoming') setReloadNonce((n) => n + 1);
  };

  const list = scope === 'upcoming' ? upcoming : others;
  const showWaitlist = scope === 'upcoming' && waitlist !== null && waitlist.length > 0;

  const chip = (active: boolean): CSSProperties => ({
    border: `1.5px solid ${active ? ORANGE : BORDER}`,
    background: active ? ORANGE_SOFT : '#fff',
    color: active ? ORANGE_INK : MUTED,
    borderRadius: 999,
    padding: '6px 14px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* status segmented control */}
      <div
        style={{
          display: 'inline-flex',
          background: '#fff',
          border: `1px solid ${BORDER}`,
          borderRadius: 999,
          padding: 3,
          gap: 2,
          alignSelf: 'flex-start',
          maxWidth: '100%',
          overflowX: 'auto',
        }}
      >
        {BOOKING_SCOPES.map((s) => {
          const active = scope === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                console.info('[customer bookings] scope', { to: s.key });
                setScope(s.key);
              }}
              style={{
                border: 'none',
                background: active ? ORANGE_SOFT : 'transparent',
                color: active ? ORANGE_INK : MUTED,
                borderRadius: 999,
                padding: '7px 16px',
                fontSize: 13.5,
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t(`customer.bookings.scope.${s.key}`)}
            </button>
          );
        })}
      </div>

      {/* period chips — only for the past scope */}
      {scope === 'past' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {BOOKING_PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriodKey(p.key)}
              style={chip(periodKey === p.key)}
            >
              {t(`customer.bookings.period.${p.key}`)}
            </button>
          ))}
        </div>
      )}

      {othersError ? (
        <div style={{ ...card, color: '#a23a3a', textAlign: 'center' }}>
          {t('customer.bookings.loadError')}
        </div>
      ) : list === null ? (
        <div style={{ ...card, color: MUTED, textAlign: 'center' }}>טוען…</div>
      ) : list.length === 0 && !showWaitlist ? (
        <div style={{ ...card, color: MUTED, textAlign: 'center' }}>
          {t(`customer.bookings.empty.${scope}`)}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {list.map((b, i) => (
            <CollapsibleBooking
              key={b.bookingId}
              booking={b}
              defaultOpen={i === 0 && scope === 'upcoming'}
              justMoved={b.bookingId === movedId}
              onChanged={onCardChanged}
              onMoved={(bookingId) => {
                console.info('[customer bookings] booking rescheduled', { bookingId });
                setMovedId(bookingId);
              }}
            />
          ))}
        </div>
      )}

      {showWaitlist && (
        <div>
          <div style={{ fontWeight: 600, margin: '6px 0 10px', color: INK }}>
            {t('customer.bookings.waitlistTitle')}
          </div>
          {waitlist!.map((w) => (
            <WaitlistEntryCard key={w.entryId} entry={w} onChanged={onReloadWaitlist} />
          ))}
        </div>
      )}
    </div>
  );
}

// One punch card as an accordion row (brief §5): collapsed shows a summary
// (remaining / total + expiry); open shows the dots visual, QR, a badge for any
// upcoming reservation made from this card, and the "הזמנת סבב" picker.
function CollapsibleCard({
  card: c,
  defaultOpen,
  linkedUpcoming,
  onGoToBookings,
  onBooked,
  onWaitlisted,
}: {
  card: ApiPunchCard;
  defaultOpen: boolean;
  linkedUpcoming: CustomerRoundBooking[];
  onGoToBookings: () => void;
  onBooked: () => void | Promise<void>;
  onWaitlisted: () => void | Promise<void>;
}) {
  const { t } = useContent();
  const [open, setOpen] = useState(defaultOpen);
  const remaining = c.totalEntries - c.usedEntries;
  const expiry =
    c.expiresAt === null
      ? t('customer.cards.noExpiry')
      : t('customer.cards.expiryUntil', { date: fmtDate(yyyyMmDd(c.expiresAt)) });
  const next = linkedUpcoming[0];
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden', ...(c.isGift && giftCardAccent) }}>
      <button
        type="button"
        onClick={() => {
          console.info('[customer cards] toggle card', { open: !open });
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          padding: '14px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'right',
          font: 'inherit',
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: INK }}>
              {c.isGift ? t('customer.cards.giftCard') : t('customer.cards.card')}
            </span>
            <span style={{ fontSize: 12, color: MUTED }} dir="ltr">
              {c.serialNumber}
            </span>
          </span>
          <span style={{ fontSize: 12.5, color: MUTED }}>
            {t('customer.cards.remaining', { remaining, total: c.totalEntries, expiry })}
          </span>
        </span>
        <span
          aria-hidden
          style={{
            color: '#c3bdb4',
            fontSize: 15,
            lineHeight: 1,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        >
          ⌄
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: '8px 16px 20px',
            borderTop: `1px solid ${BORDER}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          {c.isGift && <GiftBadge buyerName={c.giftBuyerFirstName ?? null} />}
          <PunchCard used={c.usedEntries} total={c.totalEntries} compact />
          <MemeshQr
            value={c.qrToken}
            size={180}
            title={t('customer.cards.qrTitle', { serial: c.serialNumber })}
          />
          {next && (
            <button
              type="button"
              onClick={onGoToBookings}
              style={{
                width: '100%',
                border: `1px solid #f0d9b8`,
                background: ORANGE_SOFT,
                color: '#8a5a12',
                borderRadius: 10,
                padding: '10px 14px',
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'right',
              }}
            >
              {t('customer.cards.upcomingFromCard')}{' '}
              <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
                {fmtDate(next.date)} {next.startTime}
              </span>{' '}
              ›
            </button>
          )}
          {c.isActive && remaining > 0 && (
            <PunchRoundBooking punchCard={c} onBooked={onBooked} onWaitlisted={onWaitlisted} />
          )}
        </div>
      )}
    </div>
  );
}

function CardsScreen({
  cards,
  bookings,
  error,
  onBooked,
  onWaitlisted,
  onGoToBookings,
}: {
  cards: ApiPunchCard[] | null;
  bookings: CustomerRoundBooking[] | null;
  error: string | null;
  onBooked: () => void | Promise<void>;
  onWaitlisted: () => void | Promise<void>;
  onGoToBookings: () => void;
}) {
  const { t } = useContent();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error ? (
        <div style={{ ...card, color: '#a23a3a', textAlign: 'center' }}>
          {t('customer.cards.loadError')}
        </div>
      ) : cards === null ? (
        <div style={{ ...card, color: MUTED, textAlign: 'center' }}>טוען…</div>
      ) : cards.length === 0 ? (
        <div style={{ ...card, color: MUTED, textAlign: 'center' }}>
          {t('customer.cards.empty')}
        </div>
      ) : (
        cards.map((c, i) => (
          <CollapsibleCard
            key={c.id}
            card={c}
            defaultOpen={i === 0}
            linkedUpcoming={(bookings ?? []).filter(
              (b) => b.punchCardId === c.id && b.status === 'confirmed',
            )}
            onGoToBookings={onGoToBookings}
            onBooked={onBooked}
            onWaitlisted={onWaitlisted}
          />
        ))
      )}
    </div>
  );
}

function ProfileScreen({
  profile,
  savedAt,
  onSaved,
}: {
  profile: CustomerProfile;
  savedAt: number | null;
  onSaved: () => void;
}) {
  const { t } = useContent();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
          {t('customer.profile.saved')}
        </div>
      )}
      <ProfileEdit profile={profile} onSaved={onSaved} />
    </div>
  );
}

// Day-strip status for the punch-booking picker (plan 2026-07-05-rounds-day-strip,
// Yanay's variant B pick): one dot per day, derived from the day's open rounds.
// 'closed' = an admin rule shut the day, 'free' = free play (nothing to book),
// 'none' = rounds required but none offered (past the materialized horizon).
type DayStatus = 'ok' | 'warn' | 'full' | 'free' | 'closed' | 'none';

const dayStatus = (d: DayAvailability): DayStatus => {
  if (d.closed) return 'closed';
  const openRounds = d.rounds.filter((r) => !r.isClosed);
  if (openRounds.length === 0) return d.roundsRequired ? 'none' : 'free';
  const capacity = openRounds.reduce((s, r) => s + r.capacity, 0);
  const available = openRounds.reduce((s, r) => s + r.available, 0);
  if (available === 0) return 'full';
  if (capacity > 0 && available / capacity <= 0.25) return 'warn';
  return 'ok';
};

const DAY_DOT: Record<DayStatus, string> = {
  ok: '#8fae5d',
  warn: '#e7a33e',
  full: '#cf7a6b',
  free: '#a9bac6',
  closed: '#8a7f76',
  none: '#d9d2c9',
};

const DOW_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'] as const;
const dowLetter = (dateIso: string): string =>
  DOW_LETTERS[new Date(`${dateIso}T12:00:00`).getDay()] ?? '';
const dayOfMonth = (dateIso: string): number => Number(dateIso.slice(8, 10));

// Month calendar for booking beyond the strip (Yanay 2026-07-05: customers
// should reach next month and next year themselves instead of phoning). Pure
// presentation — the parent owns the day cache and the fetching. Cells outside
// [todayIso, maxDate] are disabled; a loaded day shows the same status dot as
// its strip chip, so the two views never disagree.
function MonthCalendar({
  month,
  todayIso,
  maxDate,
  selectedDate,
  loading,
  dayFor,
  onMonthChange,
  onPick,
}: {
  month: string;
  todayIso: string;
  maxDate: string | null;
  selectedDate: string | null;
  loading: boolean;
  dayFor: (dateIso: string) => DayAvailability | undefined;
  onMonthChange: (ym: string) => void;
  onPick: (dateIso: string) => void;
}) {
  const { t } = useContent();
  const { leadingBlanks, dates } = monthGrid(month);
  const canPrev = month > monthOfIso(todayIso);
  const canNext = maxDate !== null && month < monthOfIso(maxDate);
  const navBtn = (enabled: boolean): CSSProperties => ({
    border: '1.5px solid #e9e0d9',
    background: '#fff',
    color: enabled ? '#2d3436' : '#d9d2c9',
    borderRadius: 10,
    width: 34,
    height: 34,
    fontSize: 18,
    lineHeight: '30px',
    cursor: enabled ? 'pointer' : 'default',
  });
  return (
    <div
      style={{
        border: '1.5px solid #e9e0d9',
        borderRadius: 12,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* RTL: the past sits to the right, so the right-hand button walks back. */}
        <button
          type="button"
          title={t('customer.picker.prevMonth')}
          disabled={!canPrev}
          onClick={() => canPrev && onMonthChange(addMonths(month, -1))}
          style={navBtn(canPrev)}
        >
          ›
        </button>
        <div style={{ fontSize: 14.5, fontWeight: 700 }}>{monthLabelHe(month)}</div>
        <button
          type="button"
          title={t('customer.picker.nextMonth')}
          disabled={!canNext}
          onClick={() => canNext && onMonthChange(addMonths(month, 1))}
          style={navBtn(canNext)}
        >
          ‹
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {DOW_LETTERS.map((l) => (
          <span
            key={l}
            style={{ textAlign: 'center', fontSize: 10.5, color: MUTED, fontWeight: 600 }}
          >
            {l}׳
          </span>
        ))}
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <span key={`blank-${i}`} />
        ))}
        {dates.map((dateIso) => {
          const day = dayFor(dateIso);
          const inWindow =
            dateIso >= todayIso && (maxDate === null || dateIso <= maxDate) && day !== undefined;
          const active = selectedDate === dateIso;
          return (
            <button
              key={dateIso}
              type="button"
              disabled={!inWindow}
              onClick={() => inWindow && onPick(dateIso)}
              style={{
                border: `1.5px solid ${active ? '#e7a33e' : 'transparent'}`,
                background: active ? '#fdf3e3' : 'transparent',
                borderRadius: 9,
                padding: '5px 0 4px',
                cursor: inWindow ? 'pointer' : 'default',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
              }}
            >
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: active ? 700 : 500,
                  color: inWindow ? (active ? '#b9772a' : '#2d3436') : '#d9d2c9',
                }}
              >
                {dayOfMonth(dateIso)}
              </span>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: inWindow && day ? DAY_DOT[dayStatus(day)] : 'transparent',
                }}
              />
            </button>
          );
        })}
      </div>
      {loading && (
        <div style={{ textAlign: 'center', color: MUTED, fontSize: 12.5 }}>טוען חודש…</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared day-window plumbing for every round picker in the personal area: the
// punch-booking flow and the reschedule flow (Yanay 2026-07-09 — changing a
// booking must offer other DATES, not just other times). One availability-
// range fetch feeds the strip, the month calendar pages the rest of the
// booking window, and every fetched day lands in one cache so strip, calendar
// and the day pane never disagree. Single source of truth — a second copy of
// this logic is how two pickers drift apart.
// ---------------------------------------------------------------------------

/** Which date gets selected once the range loads: keep the current pick while
 *  it's still in the window, then prefer the caller's default (the reschedule
 *  flow passes the booking's own date), then fall back to the first day
 *  (today). Pure — pinned by unit tests. */
export function pickInitialDate(
  windowDates: string[],
  current: string | null,
  defaultDate?: string,
): string | null {
  if (current && windowDates.includes(current)) return current;
  if (defaultDate && windowDates.includes(defaultDate)) return defaultDate;
  return windowDates[0] ?? null;
}

/** Open rounds a booking can move into on a given day: bookable ones minus
 *  the round the booking already sits in. Any date within the booking window
 *  is fair game — the SERVER holds the timing rule (a swap is allowed until
 *  the original round starts, rounds-swap.ts). Pure — pinned by unit tests. */
export function swapTargetsForDay(
  day: DayAvailability,
  currentRoundInstanceId: string,
): AvailabilityRound[] {
  return day.rounds.filter(
    (r) => r.available > 0 && !r.isClosed && r.roundInstanceId !== currentRoundInstanceId,
  );
}

function useRoundAvailabilityWindow(open: boolean, logNs: string, defaultDate?: string) {
  const [days, setDays] = useState<DayAvailability[] | null>(null);
  const [daysError, setDaysError] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [calMonth, setCalMonth] = useState<string | null>(null);
  const [calLoading, setCalLoading] = useState(false);
  const [maxDate, setMaxDate] = useState<string | null>(null);
  const [companionPriceIls, setCompanionPriceIls] = useState<number | null>(null);
  const [dayCache, setDayCache] = useState<Map<string, DayAvailability>>(new Map());

  const todayIso = days?.[0]?.date ?? null;
  // Everything below the strip derives from the selected day. The cache holds
  // every fetched day (strip + calendar months), so a far date picked in the
  // calendar renders exactly like a strip chip.
  const selectedDay =
    (selectedDate ? dayCache.get(selectedDate) : undefined) ??
    days?.find((d) => d.date === selectedDate) ??
    null;

  // Fresh dots every time the picker opens — availability moves under our feet.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setDays(null);
      setDaysError(false);
      // The strip keeps a month of chips; the calendar pages the rest of the
      // booking window (up to maxDate) month by month.
      const res = await getRoundAvailabilityRange(30);
      console.info(`${logNs} range loaded`, {
        ok: res.ok,
        days: res.ok ? res.data.days.length : 0,
        error: res.ok ? undefined : res.error,
      });
      if (cancelled) return;
      if (!res.ok) {
        setDaysError(true);
        setDays([]);
        return;
      }
      setDays(res.data.days);
      setMaxDate(res.data.maxDate);
      setDayCache(new Map(res.data.days.map((d) => [d.date, d])));
      setCalOpen(false);
      setCalMonth(null);
      setCompanionPriceIls(res.data.companionPriceIls);
      const stripDates = res.data.days.map((d) => d.date);
      setSelectedDate((cur) => pickInitialDate(stripDates, cur, defaultDate));
      // A default date past the strip (a booking weeks out) loads its month
      // too, so "keep the day, change the time" still opens on the right day.
      const lastStripDate = stripDates[stripDates.length - 1];
      if (
        !defaultDate ||
        stripDates.includes(defaultDate) ||
        lastStripDate === undefined ||
        defaultDate < lastStripDate ||
        defaultDate > res.data.maxDate
      ) {
        return;
      }
      const ym = monthOfIso(defaultDate);
      const monthRes = await getRoundAvailabilityRange(
        monthGrid(ym).dates.length,
        firstOfMonth(ym),
      );
      console.info(`${logNs} default-date month`, { month: ym, ok: monthRes.ok });
      if (cancelled || !monthRes.ok) return;
      setDayCache((cur) => {
        const next = new Map(cur);
        for (const d of monthRes.data.days) next.set(d.date, d);
        return next;
      });
      if (monthRes.data.days.some((d) => d.date === defaultDate)) {
        setSelectedDate(defaultDate);
        setCalMonth(ym);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The calendar pages the booking window one month per fetch; each month is
  // remembered for as long as the picker stays open.
  useEffect(() => {
    if (!calOpen || !calMonth) return;
    const { dates } = monthGrid(calMonth);
    if (!dates.some((d) => !dayCache.has(d))) return;
    let cancelled = false;
    setCalLoading(true);
    void (async () => {
      const res = await getRoundAvailabilityRange(dates.length, firstOfMonth(calMonth));
      console.info(`${logNs} calendar month`, {
        month: calMonth,
        ok: res.ok,
        days: res.ok ? res.data.days.length : 0,
        error: res.ok ? undefined : res.error,
      });
      if (cancelled) return;
      setCalLoading(false);
      if (!res.ok) return;
      setDayCache((cur) => {
        const next = new Map(cur);
        for (const d of res.data.days) next.set(d.date, d);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calOpen, calMonth]);

  const toggleCalendar = () => {
    if (!todayIso) return;
    setCalMonth((m) => m ?? monthOfIso(selectedDate ?? todayIso));
    setCalOpen((v) => {
      console.info(`${logNs} calendar toggle`, { open: !v });
      return !v;
    });
  };

  return {
    days,
    daysError,
    todayIso,
    maxDate,
    dayCache,
    companionPriceIls,
    selectedDate,
    setSelectedDate,
    selectedDay,
    calOpen,
    setCalOpen,
    calMonth,
    setCalMonth,
    calLoading,
    toggleCalendar,
  };
}

/** The horizontal day chips + the calendar toggle beside them. Pure
 *  presentation — selection state and fetching live in the window hook. */
function DayStrip({
  days,
  selectedDate,
  calOpen,
  onToggleCalendar,
  onPick,
}: {
  days: DayAvailability[];
  selectedDate: string | null;
  calOpen: boolean;
  onToggleCalendar: () => void;
  onPick: (dateIso: string) => void;
}) {
  const { t } = useContent();
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
      {/* Fixed beside the strip so far-future dates are one tap away
          without scrolling (Yanay 2026-07-05). */}
      <button
        onClick={onToggleCalendar}
        title={t('customer.picker.calendarTitle')}
        style={{
          flex: '0 0 auto',
          minWidth: 52,
          border: `1.5px solid ${calOpen ? '#e7a33e' : '#e9e0d9'}`,
          background: calOpen ? '#fdf3e3' : '#fff',
          borderRadius: 12,
          padding: '8px 6px',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
        }}
      >
        <span style={{ fontSize: 17, lineHeight: 1 }}>📅</span>
        <span style={{ fontSize: 9.5, color: MUTED, fontWeight: 600 }}>
          {t('customer.picker.calendar')}
        </span>
      </button>
      <div
        style={{
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
          padding: '2px 2px 4px',
          flex: 1,
          minWidth: 0,
        }}
      >
        {days.map((d, i) => {
          const active = selectedDate === d.date;
          return (
            <button
              key={d.date}
              onClick={() => onPick(d.date)}
              style={{
                flex: '0 0 auto',
                minWidth: 52,
                border: `1.5px solid ${active ? '#e7a33e' : '#e9e0d9'}`,
                background: active ? '#fdf3e3' : '#fff',
                borderRadius: 12,
                padding: '8px 6px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span style={{ fontSize: 10.5, color: MUTED, fontWeight: 600 }}>
                {i === 0 ? t('customer.picker.today') : `${dowLetter(d.date)}׳`}
              </span>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: active ? '#b9772a' : '#2d3436',
                }}
              >
                {dayOfMonth(d.date)}
              </span>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: DAY_DOT[dayStatus(d)],
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The dot legend under a picker — what green/amber/red/grey mean. */
function DayDotLegend() {
  const { t } = useContent();
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        justifyContent: 'center',
        fontSize: 11.5,
        color: MUTED,
        borderTop: '1px solid #f3efea',
        paddingTop: 10,
      }}
    >
      {(
        [
          ['ok', 'customer.picker.legendOk'],
          ['warn', 'customer.picker.legendWarn'],
          ['full', 'customer.picker.legendFull'],
          ['free', 'customer.picker.legendFree'],
          ['closed', 'customer.picker.legendClosed'],
        ] as const
      ).map(([k, labelKey]) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: DAY_DOT[k],
            }}
          />
          {t(labelKey)}
        </span>
      ))}
    </div>
  );
}

/** One tappable round row: label, hours (when the label lacks them), the
 *  seats-left pill and the fill bar. Shared by the punch flow (selects the
 *  round) and the reschedule flow (swaps into it on tap). */
function RoundChoiceRow({
  round,
  selected = false,
  disabled = false,
  onClick,
}: {
  round: AvailabilityRound;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useContent();
  const scarce = round.capacity > 0 && round.available / round.capacity <= 0.25;
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        border: `1.5px solid ${selected ? '#e7a33e' : '#e9e0d9'}`,
        background: selected ? '#fdf3e3' : '#fff',
        borderRadius: 10,
        padding: '10px 14px',
        fontSize: 14,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'start' }}>
        <span style={{ fontWeight: 600 }}>{round.label}</span>
        {!labelHasTime(round.label) && (
          <span style={{ color: MUTED, fontSize: 12.5 }}>
            {round.startTime}–{round.endTime}
          </span>
        )}
      </span>
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            borderRadius: 999,
            padding: '3px 9px',
            whiteSpace: 'nowrap',
            background: scarce ? '#fdf3e3' : '#eef4e2',
            color: scarce ? '#b9772a' : '#5b7a34',
          }}
        >
          {t('customer.picker.available', { count: round.available })}
        </span>
        <span
          style={{
            width: 64,
            height: 5,
            borderRadius: 999,
            background: '#f0ebe4',
            overflow: 'hidden',
            display: 'block',
          }}
        >
          <span
            style={{
              display: 'block',
              height: '100%',
              borderRadius: 999,
              width: `${round.capacity > 0 ? Math.max(6, Math.round((round.available / round.capacity) * 100)) : 0}%`,
              background: scarce ? '#e7a33e' : '#8fae5d',
            }}
          />
        </span>
      </span>
    </button>
  );
}

// ── Pre-booking rules popup ───────────────────────────────────────────────
// The blocking "important things before booking" gate (Yanay, 2026-07-17):
// fires right before a round is booked or rescheduled, mirroring the popup Yanay
// runs on the WP site so a customer can never claim they didn't know the rules.
// Four accordion sections (collapsed on open), acknowledged with a single tap.
// All copy is content-registry keys (customer_infopopup) so Yanay self-edits it.
// Presentational only — the caller owns the pending action and runs it from
// onAcknowledge. role=dialog + focus handling + scroll lock keep it accessible.
const INFO_SECTIONS = [
  { stem: 's1' },
  { stem: 's2' },
  { stem: 's3' },
  { stem: 's4' },
  { stem: 's5' },
  { stem: 's6' },
] as const;

function PreBookingInfoModal({
  source,
  onAcknowledge,
  onClose,
}: {
  /** Which flow opened it — for the diagnostic log only. */
  source: 'book' | 'reschedule';
  onAcknowledge: () => void;
  onClose: () => void;
}) {
  const { t } = useContent();
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [continueHover, setContinueHover] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = 'memesh-info-title';

  // Focus into the dialog on open, lock the page scroll behind it, and return
  // focus to whatever the customer was on once it closes.
  useEffect(() => {
    console.info('[customer rules-popup] open', { source });
    const prevActive = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cardRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, [source]);

  // ESC closes; Tab is trapped inside so focus can't wander to the page behind.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !cardRef.current) return;
    const focusables = cardRef.current.querySelectorAll<HTMLElement>(
      'button, a[href], [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const toggle = (i: number) => {
    setOpenIdx((cur) => {
      const next = cur === i ? null : i;
      console.info('[customer rules-popup] toggle', {
        section: INFO_SECTIONS[i]?.stem,
        open: next === i,
      });
      return next;
    });
  };

  const acknowledge = () => {
    console.info('[customer rules-popup] acknowledge', { source });
    onAcknowledge();
  };

  return (
    <div
      onClick={onClose}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(45,52,54,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 80,
        direction: 'rtl',
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 18,
          boxShadow: SHADOW,
          width: 460,
          maxWidth: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          outline: 'none',
        }}
      >
        <div
          style={{
            // Brand salmon header with white title — Yanay's exact color spec
            // (2026-07-18), matching the WP popup.
            background: ORANGE,
            color: '#fff',
            padding: '16px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <span id={titleId} style={{ fontSize: 19, fontWeight: 700 }}>
            {t('customer.infopopup.title')}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('customer.infopopup.closeLabel')}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#fff',
              fontSize: 20,
              lineHeight: 1,
              cursor: 'pointer',
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '4px 0' }}>
          {INFO_SECTIONS.map((s, i) => {
            const isOpen = openIdx === i;
            return (
              <div key={s.stem} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  aria-expanded={isOpen}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 18px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'right',
                  }}
                >
                  {/* Plain solid-salmon marker, no icon — matches Yanay's WP
                      site (2026-07-18). Decorative only, hidden from readers. */}
                  <span
                    aria-hidden="true"
                    style={{
                      flex: 'none',
                      width: 30,
                      height: 30,
                      borderRadius: '50%',
                      background: ORANGE,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{ display: 'block', fontSize: 14.5, fontWeight: 700, color: INK }}
                    >
                      {t(`customer.infopopup.${s.stem}.title`)}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 12.5,
                        color: MUTED,
                        marginTop: 2,
                        lineHeight: 1.5,
                      }}
                    >
                      {t(`customer.infopopup.${s.stem}.subtitle`)}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      flex: 'none',
                      color: ORANGE,
                      fontSize: 13,
                      transform: isOpen ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.18s',
                    }}
                  >
                    ▾
                  </span>
                </button>
                {isOpen && (
                  <div
                    style={{
                      paddingInlineStart: 60,
                      paddingInlineEnd: 18,
                      paddingBottom: 14,
                      fontSize: 13,
                      color: '#4a5459',
                      lineHeight: 1.7,
                      whiteSpace: 'pre-line',
                    }}
                  >
                    {t(`customer.infopopup.${s.stem}.body`)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div
          style={{
            padding: '14px 18px',
            borderTop: '1px solid #f0f0f0',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={acknowledge}
            onMouseEnter={() => setContinueHover(true)}
            onMouseLeave={() => setContinueHover(false)}
            style={{
              border: 'none',
              // Yanay's exact spec (2026-07-18): sage button, salmon on hover.
              background: continueHover ? ORANGE : '#c4d898',
              color: '#fff',
              borderRadius: 12,
              padding: '13px 18px',
              fontSize: 15,
              fontWeight: 700,
              cursor: 'pointer',
              width: '100%',
              transition: 'background 0.15s',
            }}
          >
            {t('customer.infopopup.continue')}
          </button>
          <div style={{ fontSize: 12, color: MUTED, textAlign: 'center' }}>
            {t('customer.infopopup.termsPrefix')}{' '}
            <a
              href={t('customer.bookflow.termsUrl')}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: ORANGE, textDecoration: 'underline' }}
            >
              {t('customer.infopopup.termsLink')}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

// Book a round using this card's entries (super-brief §3.4). No WooCommerce — the
// customer already paid for the card. Lives inside the punch-card card so the
// "this card → book with it" link is obvious (Yanay feedback, 2026-07-04). The
// day strip shows the full booking horizon as colored dots (Yanay's variant B
// pick, 2026-07-05); tap a day, pick an open round, pick how many entries to
// spend — a clear "spends N of M" confirm precedes the punch so it never
// happens by accident.
function PunchRoundBooking({
  punchCard,
  onBooked,
  onWaitlisted,
}: {
  punchCard: ApiPunchCard;
  onBooked: () => void | Promise<void>;
  onWaitlisted: () => void | Promise<void>;
}) {
  const { t } = useContent();
  const [open, setOpen] = useState(false);
  const [joinMsg, setJoinMsg] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [chosen, setChosen] = useState<AvailabilityRound | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [addCompanion, setAddCompanion] = useState(false);
  // The rules popup gates the confirm (Yanay, 2026-07-17): the customer must
  // acknowledge it before the booking runs. Replaces the old inline checkbox.
  const [showRules, setShowRules] = useState(false);
  // Set when the booking succeeded but the companion payment couldn't start —
  // the done screen tells the customer to retry from the booking card.
  const [companionNote, setCompanionNote] = useState<string | null>(null);
  // Strip + month calendar + day cache all live in the shared window hook
  // (also used by the reschedule flow) — fetched fresh on every open.
  const win = useRoundAvailabilityWindow(open, '[customer punch-booking]');
  const { days, daysError, todayIso, selectedDay } = win;
  const companionPrice = win.companionPriceIls;

  // A reopened form starts from a clean selection — the range reload is the
  // hook's; the punch-specific picks are ours to reset.
  useEffect(() => {
    if (!open) return;
    setChosen(null);
    setError(null);
    setJoinMsg(null);
    setShowRules(false);
  }, [open]);

  const remaining = punchCard.totalEntries - punchCard.usedEntries;
  // The stepper can never promise more than the card holds or the round seats.
  const maxCount = chosen ? Math.max(1, Math.min(remaining, chosen.available)) : remaining;

  const openRounds = selectedDay
    ? selectedDay.rounds.filter((r) => r.available > 0 && !r.isClosed)
    : [];
  const fullRounds = selectedDay
    ? selectedDay.rounds.filter((r) => r.available === 0 && !r.isClosed)
    : [];
  const roundsOff = selectedDay !== null && !selectedDay.roundsRequired;

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

  const doJoin = async (r: AvailabilityRound) => {
    setBusy(true);
    setError(null);
    const res = await joinWaitlist(r.roundInstanceId);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error === 'has_availability'
          ? t('customer.bookflow.spaceAvailable')
          : t('customer.bookflow.joinError'),
      );
      return;
    }
    setJoinMsg(t('customer.bookflow.joinedWaitlist', { time: r.startTime }));
    await onWaitlisted();
  };

  // Runs only after the rules popup is acknowledged — the popup is the gate.
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
          ? t('customer.bookflow.errNotEnoughSpace')
          : res.error === 'not_enough_entries'
            ? t('customer.bookflow.errNotEnoughEntries')
            : res.error === 'card_exhausted' || res.error === 'card_inactive'
              ? t('customer.bookflow.errNoEntries')
              : res.error === 'card_expired'
                ? t('customer.bookflow.errCardExpired')
                : t('customer.bookflow.errGeneric'),
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
        setCompanionNote(t('customer.bookflow.companionPendingNote'));
      }
    }
    setBusy(false);
    setDone(true);
    await onBooked();
  };

  if (!open) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
        <button onClick={() => setOpen(true)} style={{ ...primaryBtn, width: '100%' }}>
          {t('customer.bookflow.title')}
        </button>
        <div style={{ fontSize: 12, color: MUTED, textAlign: 'center', lineHeight: 1.5 }}>
          {t('customer.cards.notReservationNote')}
        </div>
      </div>
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
        <div style={{ fontSize: 16, fontWeight: 700 }}>{t('customer.bookflow.title')}</div>
        <button
          onClick={() => {
            setOpen(false);
            setDone(false);
            setChosen(null);
            setError(null);
          }}
          style={{
            border: 'none',
            background: 'transparent',
            color: MUTED,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {t('customer.bookflow.close')}
        </button>
      </div>

      {!done && (
        <div style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.5, marginTop: -6 }}>
          {t('customer.bookflow.roundIntro')}
        </div>
      )}

      {done ? (
        <div style={{ textAlign: 'center', fontSize: 14.5, padding: '8px 0' }}>
          <div style={{ color: '#6f8f37' }}>
            {count > 1 ? t('customer.bookflow.successMulti') : t('customer.bookflow.successSingle')}
          </div>
          {companionNote && (
            <div style={{ color: '#a8643d', fontSize: 13, marginTop: 8 }}>{companionNote}</div>
          )}
          <div
            style={{
              fontSize: 12.5,
              color: MUTED,
              lineHeight: 1.6,
              marginTop: 12,
              textAlign: 'right',
            }}
          >
            {t('customer.bookflow.confirmedRecap')}
          </div>
        </div>
      ) : (
        <>
          {daysError && (
            <div style={{ textAlign: 'center', color: '#a23a3a', fontSize: 13 }}>
              {t('customer.booking.availabilityError')}
            </div>
          )}
          {!daysError && days === null && (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 13 }}>טוען…</div>
          )}
          {days && days.length > 0 && (
            <>
              <DayStrip
                days={days}
                selectedDate={win.selectedDate}
                calOpen={win.calOpen}
                onToggleCalendar={win.toggleCalendar}
                onPick={(d) => {
                  win.setSelectedDate(d);
                  setChosen(null);
                  setError(null);
                  setJoinMsg(null);
                }}
              />
              {win.calOpen && win.calMonth && todayIso && (
                <MonthCalendar
                  month={win.calMonth}
                  todayIso={todayIso}
                  maxDate={win.maxDate}
                  selectedDate={win.selectedDate}
                  loading={win.calLoading}
                  dayFor={(d) => win.dayCache.get(d)}
                  onMonthChange={win.setCalMonth}
                  onPick={(d) => {
                    console.info('[customer punch-booking] calendar pick', { date: d });
                    win.setSelectedDate(d);
                    setChosen(null);
                    setError(null);
                    setJoinMsg(null);
                    win.setCalOpen(false);
                  }}
                />
              )}
            </>
          )}

          {selectedDay && (
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              יום {dowLetter(selectedDay.date)}׳, {fmtDate(selectedDay.date)}
            </div>
          )}
          {selectedDay && openRounds.length === 0 && (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 13 }}>
              {selectedDay.closed
                ? t('customer.bookflow.emptyClosed')
                : selectedDay.rounds.length === 0
                  ? roundsOff
                    ? t('customer.bookflow.emptyFreePlay')
                    : t('customer.bookflow.emptyNoRounds')
                  : fullRounds.length > 0
                    ? t('customer.bookflow.emptyAllFull')
                    : t('customer.bookflow.emptyNoRounds')}
            </div>
          )}
          {openRounds.length > 0 && (
            <div style={{ fontSize: 12, color: MUTED, textAlign: 'center', lineHeight: 1.5 }}>
              {t('customer.bookflow.capacityNote')}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {openRounds.map((r) => (
              <RoundChoiceRow
                key={r.roundInstanceId}
                round={r}
                selected={chosen?.roundInstanceId === r.roundInstanceId}
                onClick={() => {
                  setChosen(r);
                  setError(null);
                  setCount((c) => Math.min(c, Math.max(1, Math.min(remaining, r.available))));
                }}
              />
            ))}
          </div>

          {fullRounds.length > 0 && (
            <div style={{ borderTop: '1px solid #f3efea', paddingTop: 12 }}>
              <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 8, textAlign: 'center' }}>
                {t('customer.bookflow.allFullJoin')}
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
                      {roundTitle(r.label, r.startTime, r.endTime)}
                    </span>
                    <span style={{ fontSize: 13 }}>{t('customer.bookflow.waitlist')}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {joinMsg && (
            <div style={{ color: '#6f8f37', fontSize: 13, textAlign: 'center' }}>{joinMsg}</div>
          )}

          {chosen && (
            <div
              style={{
                borderTop: '1px solid #f3efea',
                paddingTop: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {maxCount > 1 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 14,
                  }}
                >
                  <span style={{ fontSize: 13.5 }}>{t('customer.bookflow.howManyEntries')}</span>
                  <button
                    disabled={busy || count <= 1}
                    onClick={() => setCount((c) => Math.max(1, c - 1))}
                    style={{ ...stepBtn, opacity: count <= 1 ? 0.4 : 1 }}
                  >
                    −
                  </button>
                  <span
                    style={{ fontSize: 18, fontWeight: 700, minWidth: 24, textAlign: 'center' }}
                  >
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
                  ? t('customer.bookflow.punchOne', {
                      time: `${chosen.startTime}–${chosen.endTime}`,
                      remaining,
                    })
                  : t('customer.bookflow.punchMany', {
                      count,
                      time: `${chosen.startTime}–${chosen.endTime}`,
                      remaining,
                    })}
              </div>

              <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5, textAlign: 'center' }}>
                {t('customer.bookflow.companionPolicy')}
              </div>

              {count > 1 && (
                <div style={{ fontSize: 12.5, color: MUTED, textAlign: 'center' }}>
                  {t('customer.bookflow.companionIncluded')}
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
                      <strong style={{ fontSize: 14 }}>
                        {t('customer.bookflow.extraCompanion')}
                      </strong>
                      <strong style={{ fontSize: 14, color: '#a8643d', whiteSpace: 'nowrap' }}>
                        +₪{companionPrice}
                      </strong>
                    </span>
                    <span style={{ display: 'block', fontSize: 12.5, color: MUTED, marginTop: 4 }}>
                      {t('customer.bookflow.extraCompanionNote')}
                    </span>
                  </span>
                </label>
              )}

              {/* Order composition + total headcount before confirming (Yanay #4 + #9).
                  Each punch entry is one child plus one included companion; the paid
                  extra companion is only offered on a single-entry booking. */}
              {(() => {
                const extra = count === 1 && addCompanion && companionPrice ? 1 : 0;
                return (
                  <div
                    style={{
                      border: '1px solid #f0e9e0',
                      borderRadius: 10,
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      fontSize: 13,
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 2 }}>
                      {t('customer.bookflow.summaryTitle')}
                    </div>
                    <div>
                      {t('customer.bookflow.summaryDate', {
                        date: selectedDay ? fmtDate(selectedDay.date) : '',
                      })}
                    </div>
                    <div>
                      {t('customer.bookflow.summaryRound', {
                        time: `${chosen.startTime}–${chosen.endTime}`,
                      })}
                    </div>
                    <div>{t('customer.bookflow.summaryChildren', { count })}</div>
                    <div>{t('customer.bookflow.summaryIncluded', { count })}</div>
                    {extra > 0 && (
                      <div>{t('customer.bookflow.summaryExtra', { count: extra })}</div>
                    )}
                    <div style={{ fontWeight: 700, marginTop: 3 }}>
                      {t('customer.bookflow.summaryTotal', { count: count * 2 + extra })}
                    </div>
                  </div>
                );
              })()}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  disabled={busy}
                  onClick={() => setShowRules(true)}
                  style={{ ...primaryBtn, flex: 1 }}
                >
                  {busy
                    ? 'מזמין…'
                    : count === 1 && addCompanion && companionPrice
                      ? t('customer.bookflow.confirmPay', { price: companionPrice })
                      : t('customer.bookflow.confirm')}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setChosen(null)}
                  style={{ ...ghostBtn, flex: 1 }}
                >
                  {t('customer.booking.backButton')}
                </button>
              </div>
            </div>
          )}

          {showRules && (
            <PreBookingInfoModal
              source="book"
              onClose={() => setShowRules(false)}
              onAcknowledge={() => {
                setShowRules(false);
                void doBook();
              }}
            />
          )}

          {error && (
            <div style={{ color: '#a23a3a', fontSize: 13, textAlign: 'center' }}>{error}</div>
          )}

          {days && days.length > 0 && <DayDotLegend />}
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
  const { t } = useContent();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doLeave = async () => {
    setBusy(true);
    setError(null);
    const res = await leaveWaitlist(entry.entryId);
    setBusy(false);
    if (!res.ok) {
      setError(t('customer.waitlist.leaveError'));
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
        {labelHasTime(entry.label)
          ? entry.label
          : `${entry.label} · ${entry.startTime}–${entry.endTime}`}
      </div>
      <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{fmtDate(entry.date)}</div>
      {notified ? (
        <div style={{ marginTop: 10, color: '#5f7d2e', fontSize: 13.5, fontWeight: 600 }}>
          {t('customer.waitlist.claimAvailable', {
            deadline: claimTime
              ? ` ${t('customer.waitlist.claimDeadline', { time: claimTime })}`
              : '',
          })}
        </div>
      ) : (
        <div style={{ marginTop: 10, color: MUTED, fontSize: 13 }}>
          {t('customer.waitlist.waiting')}
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
        {t('customer.waitlist.leave')}
      </button>
      {error && <div style={{ color: '#a23a3a', fontSize: 13, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// A single round booking with its barcode + a reschedule flow: pick another
// round on ANY open day in the booking window and swap into it (super-brief
// §6.1; Yanay 2026-07-09 — date change, not only time). The server allows the
// swap until the ORIGINAL round starts and re-mints the QR on success.
function RoundBookingCard({
  booking,
  onSwapped,
  onMoved,
  compact = false,
}: {
  booking: CustomerRoundBooking;
  onSwapped: () => void | Promise<void>;
  /** Fired after a successful reschedule, once the list has reloaded — the
   *  parent highlights and scrolls to the booking's new slot in the list. */
  onMoved?: () => void;
  /** Inside the accordion: drop the card chrome + the label/date lines (the
   *  collapsible header carries them) and render only the body. */
  compact?: boolean;
}) {
  const { t } = useContent();
  const [picking, setPicking] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The rules popup gates the swap too (Yanay, 2026-07-17): choosing a target
  // stashes it here and opens the popup; the swap runs once it's acknowledged.
  const [pendingSwap, setPendingSwap] = useState<string | null>(null);
  // The same strip+calendar window as the punch flow, preselected to the
  // booking's own date — "keep the day, change the time" is the common case,
  // but any open day is a tap away (Yanay 2026-07-09: date change, not just
  // time; the server allows a swap until the ORIGINAL round starts).
  const win = useRoundAvailabilityWindow(picking, '[customer reschedule]', booking.date);
  const swapTargets = win.selectedDay
    ? swapTargetsForDay(win.selectedDay, booking.roundInstanceId)
    : [];

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

  const doSwap = async (targetRoundInstanceId: string) => {
    setBusy(true);
    setError(null);
    console.info('[customer reschedule] swapping', {
      bookingId: booking.bookingId,
      from: booking.roundInstanceId,
      to: targetRoundInstanceId,
    });
    const res = await swapRoundBooking(booking.bookingId, targetRoundInstanceId);
    setBusy(false);
    if (!res.ok) {
      console.warn('[customer reschedule] swap rejected', {
        bookingId: booking.bookingId,
        error: res.error,
      });
      setError(
        res.error === 'target_full'
          ? t('customer.booking.swapErrorFull')
          : res.error === 'too_late'
            ? t('customer.booking.swapErrorTooLate')
            : t('customer.booking.swapErrorGeneric'),
      );
      return;
    }
    console.info('[customer reschedule] swap done', { bookingId: booking.bookingId });
    setPicking(false);
    await onSwapped();
    // Only after the reload: the highlight must land on the re-sorted list.
    onMoved?.();
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
    setError(t('customer.booking.companionPayError'));
  };

  const doCancel = async () => {
    setBusy(true);
    setError(null);
    const res = await cancelRoundBooking(booking.bookingId);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error === 'too_late'
          ? t('customer.booking.cancelErrorTooLate')
          : res.error === 'refund_failed'
            ? t('customer.booking.cancelErrorRefundFailed')
            : t('customer.booking.cancelErrorGeneric'),
      );
      return;
    }
    // The list reload drops the cancelled booking (it's no longer confirmed).
    setConfirmingCancel(false);
    await onSwapped();
  };

  return (
    <div
      style={
        compact
          ? {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 14,
              width: '100%',
            }
          : {
              ...card,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 14,
              marginBottom: 12,
            }
      }
    >
      {!compact && <div style={{ fontSize: 16, fontWeight: 600 }}>{booking.label}</div>}
      {!compact && (
        <div style={{ fontSize: 13, color: MUTED }}>
          {labelHasTime(booking.label)
            ? fmtDate(booking.date)
            : `${fmtDate(booking.date)} · ${booking.startTime}–${booking.endTime}`}
        </div>
      )}
      {booking.barcodeToken && booking.status !== 'cancelled' && (
        <MemeshQr
          value={booking.barcodeToken}
          size={180}
          title={t('customer.booking.qrTitle', { label: booking.label })}
        />
      )}
      {booking.bookingNumber && (
        <div style={{ fontSize: 13, color: MUTED }}>{booking.bookingNumber}</div>
      )}
      <div style={{ fontSize: 12.5, color: MUTED }}>
        {booking.ticketType === 'child_under_walking'
          ? t('customer.booking.ticketBaby')
          : t('customer.booking.ticketChild')}
        {booking.additionalCompanions > 0 ? ` · ${t('customer.booking.withCompanion')}` : ''}
        {booking.status === 'used' ? ` · ${t('customer.booking.used')}` : ''}
      </div>

      {booking.source === 'punchcard' && booking.status === 'confirmed' && (
        <div
          style={{
            width: '100%',
            fontSize: 12.5,
            color: '#8a5a12',
            background: '#fff4e2',
            border: '1px solid #f0d9b8',
            borderRadius: 10,
            padding: '8px 12px',
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          {t('customer.booking.punchcardNote')}
        </div>
      )}

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
          <span style={{ fontSize: 13, color: '#a8643d' }}>
            {t('customer.booking.companionPending')}
          </span>
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
            {busy ? 'רגע…' : t('customer.booking.companionPayButton')}
          </button>
        </div>
      )}

      {booking.status === 'confirmed' && !picking && !confirmingCancel && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            onClick={() => {
              console.info('[customer reschedule] picker opened', {
                bookingId: booking.bookingId,
                date: booking.date,
              });
              setPicking(true);
              setError(null);
            }}
            style={secondaryBtn}
          >
            {t('customer.booking.rescheduleButton')}
          </button>
          <button
            onClick={() => {
              setConfirmingCancel(true);
              setError(null);
            }}
            style={dangerBtn}
          >
            {t('customer.booking.cancelButton')}
          </button>
          <div
            style={{
              flexBasis: '100%',
              fontSize: 12,
              color: MUTED,
              textAlign: 'center',
              marginTop: 2,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <span>{t('customer.policy.cancel')}</span>
            <span>{t('customer.policy.reschedule')}</span>
          </div>
        </div>
      )}

      {confirmingCancel && (
        <div style={{ width: '100%', borderTop: '1px solid #f3efea', paddingTop: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4, textAlign: 'center' }}>
            {t('customer.booking.cancelConfirmTitle')}
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 12, textAlign: 'center' }}>
            {booking.source === 'punchcard'
              ? booking.additionalCompanions > 0
                ? t('customer.booking.cancelRefundPunchCompanion')
                : t('customer.booking.cancelRefundPunch')
              : t('customer.booking.cancelRefundPaid')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              disabled={busy}
              onClick={() => void doCancel()}
              style={{ ...dangerBtn, flex: 1 }}
            >
              {busy ? 'מבטל…' : t('customer.booking.cancelConfirmButton')}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setConfirmingCancel(false);
                setError(null);
              }}
              style={{ ...secondaryBtn, flex: 1 }}
            >
              {t('customer.booking.backButton')}
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
        <div
          style={{
            width: '100%',
            borderTop: '1px solid #f3efea',
            paddingTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 600, textAlign: 'center' }}>
            {t('customer.booking.pickerTitle')}
          </div>
          {win.daysError && (
            <div style={{ textAlign: 'center', color: '#a23a3a', fontSize: 13 }}>
              {t('customer.booking.availabilityError')}
            </div>
          )}
          {!win.daysError && win.days === null && (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 13 }}>טוען…</div>
          )}
          {win.days && win.days.length > 0 && (
            <>
              <DayStrip
                days={win.days}
                selectedDate={win.selectedDate}
                calOpen={win.calOpen}
                onToggleCalendar={win.toggleCalendar}
                onPick={(d) => {
                  win.setSelectedDate(d);
                  setError(null);
                }}
              />
              {win.calOpen && win.calMonth && win.todayIso && (
                <MonthCalendar
                  month={win.calMonth}
                  todayIso={win.todayIso}
                  maxDate={win.maxDate}
                  selectedDate={win.selectedDate}
                  loading={win.calLoading}
                  dayFor={(d) => win.dayCache.get(d)}
                  onMonthChange={win.setCalMonth}
                  onPick={(d) => {
                    console.info('[customer reschedule] calendar pick', { date: d });
                    win.setSelectedDate(d);
                    setError(null);
                    win.setCalOpen(false);
                  }}
                />
              )}
            </>
          )}
          {win.selectedDay && (
            <div style={{ fontSize: 14, fontWeight: 700, textAlign: 'center' }}>
              יום {dowLetter(win.selectedDay.date)}׳, {fmtDate(win.selectedDay.date)}
              {win.selectedDay.date === booking.date
                ? ` ${t('customer.booking.pickerOwnDateBadge')}`
                : ''}
            </div>
          )}
          {win.selectedDay && swapTargets.length === 0 && (
            <div style={{ textAlign: 'center', color: MUTED, fontSize: 13 }}>
              {win.selectedDay.closed
                ? t('customer.booking.pickerEmptyClosed')
                : !win.selectedDay.roundsRequired
                  ? t('customer.booking.pickerEmptyFreePlay')
                  : win.selectedDay.date === booking.date
                    ? t('customer.booking.pickerEmptySameDay')
                    : t('customer.booking.pickerEmptyOtherDay')}
            </div>
          )}
          {swapTargets.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {swapTargets.map((r) => (
                <RoundChoiceRow
                  key={r.roundInstanceId}
                  round={r}
                  disabled={busy}
                  onClick={() => setPendingSwap(r.roundInstanceId)}
                />
              ))}
            </div>
          )}
          <div style={{ textAlign: 'center', color: MUTED, fontSize: 12 }}>
            {t('customer.policy.reschedule')}
          </div>
          {pendingSwap && (
            <PreBookingInfoModal
              source="reschedule"
              onClose={() => setPendingSwap(null)}
              onAcknowledge={() => {
                const target = pendingSwap;
                setPendingSwap(null);
                if (target) void doSwap(target);
              }}
            />
          )}
          {error && (
            <div style={{ color: '#a23a3a', fontSize: 13, textAlign: 'center' }}>{error}</div>
          )}
          <button
            onClick={() => {
              setPicking(false);
              setError(null);
            }}
            disabled={busy}
            style={{
              border: 'none',
              background: 'transparent',
              color: MUTED,
              fontSize: 13,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            {t('customer.booking.backButton')}
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
  /** Omitted inside the app shell, where the nav replaces a back button. */
  onBack?: () => void;
}) {
  const { t } = useContent();
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
      setError(t('customer.profile.errRequired'));
      return;
    }
    if (te && !/^\S+@\S+\.\S+$/.test(te)) {
      setError(t('customer.profile.errEmail'));
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
      setError(humanizeUpdateError(res.error, t));
      return;
    }
    setProfile(res.data.profile);
    onSaved();
  };

  return (
    <div>
      {onBack && <BackButton onClick={onBack} />}
      <form onSubmit={onSubmit} style={card}>
        <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>
          {t('customer.profile.editTitle')}
        </div>
        <Labeled label={t('customer.profile.firstName')}>
          <input
            style={inputStyle}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            disabled={submitting}
          />
        </Labeled>
        <Spacer />
        <Labeled label={t('customer.profile.lastName')}>
          <input
            style={inputStyle}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            disabled={submitting}
          />
        </Labeled>
        <Spacer />
        <Labeled label={t('customer.profile.phone')}>
          <input
            value={profile.phone}
            disabled
            style={{ ...inputStyle, background: '#f6f3f0', color: MUTED }}
          />
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
            {t('customer.profile.phoneLocked')}
          </div>
        </Labeled>
        <Spacer />
        <Labeled label={t('customer.profile.email')}>
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
          <div style={{ fontSize: 13.5, color: MUTED, marginBottom: 8 }}>
            {t('customer.profile.preferredChannel')}
          </div>
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
                  {t(ch.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
        {profile.children.length > 0 && (
          <div style={{ margin: '14px 0' }}>
            <div style={{ fontSize: 13.5, color: MUTED, marginBottom: 8 }}>
              {t('customer.profile.children')}
            </div>
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
              {t('customer.profile.childrenLocked')}
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
            {t('customer.profile.cancel')}
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
            {submitting ? 'שומר…' : t('customer.profile.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function humanizeUpdateError(code: string, t: (key: string) => string): string {
  if (code === 'invalid_body') return t('customer.profile.errInvalidBody');
  if (code === 'not_found') return t('customer.profile.errNotFound');
  return t('customer.profile.errGeneric');
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
  const { t } = useContent();
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
      ← {t('customer.booking.backButton')}
    </button>
  );
}
