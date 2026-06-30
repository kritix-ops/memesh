import { Sun } from '@memesh/brand';
import {
  claimGift,
  getGiftPreview,
  requestGiftClaimOtp,
  type GiftPreview,
} from '@memesh/customer-auth';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// Landing page that opens when a recipient taps the magic link in the gift
// email (`/gift/:claimToken`). Three states with a thin spinner between
// transitions; the recipient should never see a blank page.
//
//   loading        — fetching preview from /gift/preview/:token
//   error          — preview failed (404 unknown / 410 claimed / 410 expired)
//   ready          — show the gift summary + phone entry
//   sending_otp    — POST /request-otp inflight
//   awaiting_code  — OTP sent, show 6-digit input
//   verifying      — POST /claim inflight
//   success        — show success card, CTA into the personal area
//
// Diagnostic logs cover every step ([gift-claim ...]); see rule 14 in the
// global CLAUDE.md. Logs print booleans + lengths but never the raw token
// or the OTP itself.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; error: 'gift_not_found' | 'gift_already_claimed' | 'gift_expired' | 'unknown' }
  | { kind: 'ready'; gift: GiftPreview }
  | { kind: 'sending_otp'; gift: GiftPreview; phone: string }
  | { kind: 'awaiting_code'; gift: GiftPreview; phone: string }
  | { kind: 'verifying'; gift: GiftPreview; phone: string; code: string }
  | { kind: 'success'; gift: GiftPreview };

interface Props {
  claimToken: string;
}

export function GiftClaim({ claimToken }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [phoneInput, setPhoneInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const cancelled = useRef(false);

  // -- Preview fetch on mount --
  useEffect(() => {
    cancelled.current = false;
    void (async () => {
      console.info('[gift-claim preview] fetching', { tokenLength: claimToken.length });
      const res = await getGiftPreview(claimToken);
      if (cancelled.current) return;
      if (res.ok) {
        console.info('[gift-claim preview] ready', {
          buyerFirstName: res.data.gift.buyerFirstName,
          recipientFirstName: res.data.gift.recipientFirstName,
          hasCardDetails: res.data.gift.card !== null,
        });
        setState({ kind: 'ready', gift: res.data.gift });
        return;
      }
      console.warn('[gift-claim preview] failed', { status: res.status, error: res.error });
      const error =
        res.error === 'gift_not_found' ||
        res.error === 'gift_already_claimed' ||
        res.error === 'gift_expired'
          ? res.error
          : 'unknown';
      setState({ kind: 'error', error });
    })();
    return () => {
      cancelled.current = true;
    };
  }, [claimToken]);

  // -- Submit handlers --
  const onSendOtp = async () => {
    if (state.kind !== 'ready') return;
    const phone = phoneInput.trim();
    if (phone.length < 9) {
      setStatusMessage('נא להזין מספר טלפון תקין');
      return;
    }
    setStatusMessage(null);
    setState({ kind: 'sending_otp', gift: state.gift, phone });
    console.info('[gift-claim otp request] sending');
    const res = await requestGiftClaimOtp(claimToken, phone);
    if (res.ok) {
      console.info('[gift-claim otp request] sent');
      setState({ kind: 'awaiting_code', gift: state.gift, phone });
      setStatusMessage('שלחנו לך קוד אימות ב-SMS.');
    } else {
      console.warn('[gift-claim otp request] failed', { status: res.status, error: res.error });
      const message =
        res.error === 'phone_mismatch'
          ? 'המספר אינו תואם. ודאו שזה המספר שאליו נשלחה המתנה, או פנו לשולח/ת.'
          : res.error === 'gift_already_claimed'
            ? 'הכרטיסייה כבר נפתחה.'
            : res.error === 'gift_expired'
              ? 'הקישור פג תוקף.'
              : 'אירעה תקלה. ננסה שוב?';
      setState({ kind: 'ready', gift: state.gift });
      setStatusMessage(message);
    }
  };

  const onVerifyCode = async () => {
    if (state.kind !== 'awaiting_code') return;
    const code = codeInput.trim();
    if (!/^\d{4,8}$/.test(code)) {
      setStatusMessage('נא להזין את קוד האימות (4-8 ספרות)');
      return;
    }
    setStatusMessage(null);
    setState({ kind: 'verifying', gift: state.gift, phone: state.phone, code });
    console.info('[gift-claim claim] verifying', { phoneLength: state.phone.length, codeLength: code.length });
    const res = await claimGift(claimToken, state.phone, code);
    if (res.ok) {
      console.info('[gift-claim claim] success', { customerId: res.data.customerId });
      setState({ kind: 'success', gift: state.gift });
    } else {
      console.warn('[gift-claim claim] failed', { status: res.status, error: res.error });
      const message =
        res.error === 'invalid_code'
          ? 'הקוד שגוי. נסו שוב.'
          : res.error === 'code_expired'
            ? 'הקוד פג תוקף. בקשו קוד חדש.'
            : res.error === 'code_locked'
              ? 'נסיונות רבים מדי. ננעל למשך כמה דקות, אחר כך בקשו קוד חדש.'
              : res.error === 'gift_already_claimed'
                ? 'הכרטיסייה כבר נפתחה.'
                : 'אירעה תקלה. ננסה שוב?';
      // Reset to OTP entry so user can retry with a fresh code if needed.
      setState({ kind: 'awaiting_code', gift: state.gift, phone: state.phone });
      setStatusMessage(message);
    }
  };

  const onSuccessCta = () => {
    // Single-use token; strip from URL so a back-button revisit doesn't
    // try to re-claim an already-claimed row.
    window.history.replaceState({}, '', '/');
    window.location.assign('/');
  };

  // -- Render --
  if (state.kind === 'loading') return <Centered><LoadingCard message="טוען את המתנה…" /></Centered>;
  if (state.kind === 'error') return <Centered><ErrorCard error={state.error} /></Centered>;
  if (state.kind === 'success') return <Centered><SuccessCard gift={state.gift} onCta={onSuccessCta} /></Centered>;

  const gift = state.gift;
  const inFlight = state.kind === 'sending_otp' || state.kind === 'verifying';
  const showCodeForm = state.kind === 'awaiting_code' || state.kind === 'verifying';

  return (
    <Centered>
      <GiftHero gift={gift} />
      <Card>
        {showCodeForm ? (
          <CodeForm
            value={codeInput}
            onChange={setCodeInput}
            onSubmit={onVerifyCode}
            disabled={inFlight}
            statusMessage={statusMessage}
            phone={state.kind === 'awaiting_code' || state.kind === 'verifying' ? state.phone : ''}
            inFlight={state.kind === 'verifying'}
          />
        ) : (
          <PhoneForm
            value={phoneInput}
            onChange={setPhoneInput}
            onSubmit={onSendOtp}
            disabled={inFlight}
            statusMessage={statusMessage}
            inFlight={state.kind === 'sending_otp'}
          />
        )}
      </Card>
    </Centered>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function GiftHero({ gift }: { gift: GiftPreview }) {
  return (
    <div style={heroCardStyle}>
      <div style={{ fontSize: 56, lineHeight: 1, marginBottom: 4 }} aria-hidden="true">
        🎁
      </div>
      <h1 style={heroTitleStyle}>
        {gift.recipientFirstName ? `${gift.recipientFirstName}, ` : ''}
        קיבלת מתנה!
      </h1>
      <p style={heroSubtitleStyle}>
        <strong style={{ color: '#a05a23' }}>{gift.buyerFirstName}</strong>
        {' שלח/ה לך כרטיסיית '}
        <strong>Memesh</strong>.
      </p>
      {gift.card && (
        <p style={heroDetailStyle}>
          {gift.card.totalEntries} כניסות
          {gift.card.validityDays === null
            ? ' (ללא תפוגה)'
            : `, תקף ${gift.card.validityDays} יום מרגע הקבלה`}
          .
        </p>
      )}
    </div>
  );
}

function PhoneForm({
  value,
  onChange,
  onSubmit,
  disabled,
  statusMessage,
  inFlight,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  statusMessage: string | null;
  inFlight: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <label htmlFor="gift-phone" style={labelStyle}>
        להמשך, הזינו את מספר הטלפון שלכם
      </label>
      <input
        id="gift-phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        dir="ltr"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="050-0000000"
        style={inputStyle}
        disabled={disabled}
      />
      <button type="submit" style={ctaStyle} disabled={disabled}>
        {inFlight ? 'שולחים קוד…' : 'שלחו לי קוד אימות ב-SMS'}
      </button>
      <p style={helperStyle}>
        הקוד יישלח רק אם המספר תואם למה שהוזן בעת רכישת המתנה. אם יש בעיה, פנו לשולח/ת.
      </p>
      {statusMessage && <Banner kind="info">{statusMessage}</Banner>}
    </form>
  );
}

function CodeForm({
  value,
  onChange,
  onSubmit,
  disabled,
  statusMessage,
  phone,
  inFlight,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  statusMessage: string | null;
  phone: string;
  inFlight: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <label htmlFor="gift-code" style={labelStyle}>
        קוד אימות שנשלח ל-{phone}
      </label>
      <input
        id="gift-code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="------"
        style={{ ...inputStyle, letterSpacing: '0.4em', textAlign: 'center' }}
        maxLength={8}
        disabled={disabled}
      />
      <button type="submit" style={ctaStyle} disabled={disabled}>
        {inFlight ? 'מאמתים…' : 'אמתו וקבלו את המתנה'}
      </button>
      {statusMessage && <Banner kind="info">{statusMessage}</Banner>}
    </form>
  );
}

function LoadingCard({ message }: { message: string }) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Sun size={56} spin />
      </div>
      <div style={{ textAlign: 'center', marginTop: 12, color: '#636e72' }}>{message}</div>
    </Card>
  );
}

type GiftClaimErrorKind = 'gift_not_found' | 'gift_already_claimed' | 'gift_expired' | 'unknown';

function ErrorCard({ error }: { error: GiftClaimErrorKind }) {
  const messages: Record<GiftClaimErrorKind, { title: string; body: string }> = {
    gift_not_found: {
      title: 'הקישור אינו תקף',
      body: 'הקישור הזה לא מוכר במערכת. ייתכן שהוא הועתק חלקית. פנו לשולח/ת המתנה כדי לקבל קישור חדש.',
    },
    gift_already_claimed: {
      title: 'המתנה כבר נפתחה',
      body: 'נראה שכבר פתחת את המתנה הזו. אפשר להיכנס לאזור האישי עם מספר הטלפון שלך וקוד SMS.',
    },
    gift_expired: {
      title: 'הקישור פג תוקף',
      body: 'עברו יותר משנה מאז שהמתנה נשלחה. פנו לשולח/ת — נשמח לעזור.',
    },
    unknown: {
      title: 'אירעה תקלה',
      body: 'לא הצלחנו לטעון את פרטי המתנה. רעננו את הדף, ואם זה ממשיך — צרו קשר.',
    },
  };
  const msg = messages[error];
  return (
    <Card>
      <div style={{ fontSize: 40, textAlign: 'center' }} aria-hidden="true">🎁</div>
      <h1 style={errorTitleStyle}>{msg.title}</h1>
      <p style={bodyStyle}>{msg.body}</p>
      <a href="/" style={ghostCtaStyle}>
        לאזור האישי
      </a>
    </Card>
  );
}

function SuccessCard({ gift, onCta }: { gift: GiftPreview; onCta: () => void }) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Sun size={64} />
      </div>
      <h1 style={readyTitleStyle}>פתחת את המתנה! 🎉</h1>
      <p style={bodyStyle}>
        הכרטיסייה ש-{gift.buyerFirstName} שלח/ה לך מחכה לך באזור האישי.
      </p>
      <button type="button" style={ctaStyle} onClick={onCta}>
        לאזור האישי שלי
      </button>
    </Card>
  );
}

function Banner({ kind, children }: { kind: 'info' | 'error'; children: ReactNode }) {
  return (
    <div
      style={{
        ...bannerStyle,
        background: kind === 'error' ? '#fdecec' : '#fff4ec',
        color: kind === 'error' ? '#a23a3a' : '#a05a23',
        border: `1px solid ${kind === 'error' ? '#f2c0c0' : '#ffd9bb'}`,
      }}
    >
      {children}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div style={cardStyle}>{children}</div>;
}

function Centered({ children }: { children: ReactNode }) {
  return <main style={pageStyle}>{children}</main>;
}

// ---------------------------------------------------------------------------
// Styles (CSS-in-JS, same approach the rest of the customer app uses)
// ---------------------------------------------------------------------------

const pageStyle: CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  padding: '40px 18px 64px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const cardStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 18,
  boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
  padding: '32px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const heroCardStyle: CSSProperties = {
  background: 'linear-gradient(180deg, #fff8f1 0%, #ffe7d1 100%)',
  border: '1.5px solid #ffd9bb',
  borderRadius: 18,
  padding: '28px 24px 24px',
  textAlign: 'center',
  boxShadow: '0 8px 32px rgba(246,169,110,0.22)',
};

const heroTitleStyle: CSSProperties = {
  margin: '8px 0 4px',
  fontSize: 26,
  fontWeight: 700,
  color: '#2d3436',
  lineHeight: 1.25,
};

const heroSubtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 17,
  color: '#5a6168',
  lineHeight: 1.55,
};

const heroDetailStyle: CSSProperties = {
  marginTop: 12,
  fontSize: 14,
  color: '#a98d7d',
  lineHeight: 1.5,
};

const labelStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: '#2d3436',
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

const ctaStyle: CSSProperties = {
  background: '#ffa983',
  color: '#fff',
  border: 'none',
  borderRadius: 12,
  padding: '16px 24px',
  fontSize: 17,
  fontWeight: 700,
  cursor: 'pointer',
  width: '100%',
  textAlign: 'center',
  textDecoration: 'none',
};

const ghostCtaStyle: CSSProperties = {
  background: '#fff',
  color: '#a98d7d',
  border: '1.5px solid #e9e0d9',
  borderRadius: 12,
  padding: '14px 24px',
  fontSize: 16,
  fontWeight: 700,
  cursor: 'pointer',
  width: '100%',
  textAlign: 'center',
  textDecoration: 'none',
  display: 'inline-block',
  boxSizing: 'border-box',
};

const helperStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 13,
  color: '#8a8f95',
  lineHeight: 1.5,
};

const bannerStyle: CSSProperties = {
  padding: '12px 16px',
  borderRadius: 12,
  fontSize: 14,
  lineHeight: 1.5,
};

const readyTitleStyle: CSSProperties = {
  margin: '8px 0 0',
  fontSize: 26,
  fontWeight: 700,
  color: '#2d3436',
  lineHeight: 1.25,
  textAlign: 'center',
};

const errorTitleStyle: CSSProperties = {
  margin: '8px 0 0',
  fontSize: 22,
  fontWeight: 700,
  color: '#2d3436',
  textAlign: 'center',
};

const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  color: '#636e72',
  lineHeight: 1.55,
  textAlign: 'center',
};
