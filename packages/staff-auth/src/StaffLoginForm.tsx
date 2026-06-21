import { INK, MUTED, ORANGE, Sun } from '@memesh/brand';
import { useState, type CSSProperties, type FormEvent } from 'react';
import { staffForgotPassword, staffResetPassword } from './api/auth';
import { useStaffSession } from './staff-session';

const SHADOW = '0 4px 20px rgba(0,0,0,0.08)';
const MIN_NEW_PASSWORD_LENGTH = 8;

const card: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 28,
};

const inputStyle: CSSProperties = {
  width: '100%',
  fontSize: 17,
  padding: '14px 16px',
  border: '1.5px solid #e9e0d9',
  borderRadius: 12,
  background: '#fff',
  outline: 'none',
  marginTop: 6,
  boxSizing: 'border-box',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 13.5,
  color: MUTED,
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
  marginTop: 22,
};

const linkBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: ORANGE,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  padding: '12px 0 0',
  textAlign: 'center',
  width: '100%',
};

const errorBanner: CSSProperties = {
  marginTop: 16,
  padding: '10px 14px',
  background: '#fbecec',
  color: '#a23a3a',
  borderRadius: 10,
  fontSize: 14,
};

const successBanner: CSSProperties = {
  marginTop: 16,
  padding: '10px 14px',
  background: '#e8f5e9',
  color: '#2e7d32',
  borderRadius: 10,
  fontSize: 14,
};

const infoBanner: CSSProperties = {
  marginTop: 16,
  padding: '10px 14px',
  background: '#fff7ee',
  color: '#7a4a1a',
  borderRadius: 10,
  fontSize: 14,
};

/**
 * Top-level form for the signed-out shell. Renders one of three sub-views
 * based on session state: regular email+password login, "forgot my password",
 * or "set a new password" (when the URL carries ?reset_token=). Apps just
 * render this component — no router needed.
 */
export function StaffLoginForm() {
  const { signedOutView } = useStaffSession();
  return (
    <main style={{ maxWidth: 420, margin: '0 auto', padding: '56px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
        <Sun size={56} />
      </div>
      {signedOutView === 'login' && <LoginView />}
      {signedOutView === 'forgot' && <ForgotPasswordView />}
      {signedOutView === 'reset' && <ResetPasswordView />}
    </main>
  );
}

function LoginView() {
  const { signIn, setSignedOutView } = useStaffSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('נא למלא דוא"ל וסיסמה');
      return;
    }
    setSubmitting(true);
    setError(null);
    console.info('[web auth] login submit');
    const result = await signIn(trimmedEmail, password);
    setSubmitting(false);
    if (!result.ok) {
      setError(humanizeLoginError(result.error));
    }
  };

  return (
    <form onSubmit={onSubmit} style={card}>
      <div style={{ fontSize: 22, fontWeight: 600, color: INK }}>כניסת צוות</div>
      <div style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 18 }}>
        הזינו דוא"ל וסיסמה כדי להמשיך
      </div>

      <label style={labelStyle}>
        דוא"ל
        <input
          style={inputStyle}
          type="email"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          disabled={submitting}
          dir="ltr"
        />
      </label>

      <label style={{ ...labelStyle, marginTop: 14 }}>
        סיסמה
        <input
          style={inputStyle}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
        />
      </label>

      {error && (
        <div role="alert" style={errorBanner}>
          {error}
        </div>
      )}

      <button
        type="submit"
        style={{
          ...primaryBtn,
          opacity: submitting ? 0.6 : 1,
          cursor: submitting ? 'default' : 'pointer',
        }}
        disabled={submitting}
      >
        {submitting ? 'מתחבר…' : 'כניסה'}
      </button>

      <button
        type="button"
        style={linkBtn}
        onClick={() => {
          console.info('[web auth] switching to forgot view');
          setSignedOutView('forgot');
        }}
      >
        שכחתי סיסמה
      </button>
    </form>
  );
}

function ForgotPasswordView() {
  const { setSignedOutView } = useStaffSession();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('נא להזין כתובת דוא"ל');
      return;
    }
    setSubmitting(true);
    setError(null);
    console.info('[web auth] forgot requested', { email: trimmedEmail });
    const result = await staffForgotPassword(trimmedEmail);
    setSubmitting(false);
    if (!result.ok) {
      // API returns 400 only on a malformed body; treat anything else as a
      // generic failure but never surface "we don't know that email" — that
      // would defeat the no-enumeration discipline on the server side.
      console.warn('[web auth] forgot request rejected', { error: result.error });
      setError('שליחת הקישור נכשלה. נסו שוב בעוד רגע.');
      return;
    }
    console.info('[web auth] forgot request accepted');
    setSubmitted(true);
  };

  return (
    <form onSubmit={onSubmit} style={card}>
      <div style={{ fontSize: 22, fontWeight: 600, color: INK }}>איפוס סיסמה</div>
      <div style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 18 }}>
        נשלח קישור לאיפוס סיסמה לכתובת הדוא"ל שלכם
      </div>

      <label style={labelStyle}>
        דוא"ל
        <input
          style={inputStyle}
          type="email"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          disabled={submitting || submitted}
          dir="ltr"
        />
      </label>

      {error && (
        <div role="alert" style={errorBanner}>
          {error}
        </div>
      )}

      {submitted && (
        <div role="status" style={infoBanner}>
          אם הכתובת רשומה אצלנו, שלחנו אליה קישור לאיפוס סיסמה. הקישור תקף ל-30
          דקות. בדקו גם בתיקיית הספאם.
        </div>
      )}

      {!submitted && (
        <button
          type="submit"
          style={{
            ...primaryBtn,
            opacity: submitting ? 0.6 : 1,
            cursor: submitting ? 'default' : 'pointer',
          }}
          disabled={submitting}
        >
          {submitting ? 'שולח…' : 'שליחת קישור'}
        </button>
      )}

      <button
        type="button"
        style={linkBtn}
        onClick={() => {
          console.info('[web auth] switching back to login view');
          setSignedOutView('login');
        }}
      >
        חזרה לכניסה
      </button>
    </form>
  );
}

function ResetPasswordView() {
  const { resetToken, clearResetToken, setSignedOutView } = useStaffSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!resetToken) {
    // Defensive: provider only flips to 'reset' when the URL has a token,
    // but render a friendly path anyway in case state got out of sync.
    return (
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 600, color: INK }}>
          הקישור לא תקף
        </div>
        <div style={{ color: MUTED, fontSize: 14, marginTop: 8 }}>
          הקישור לאיפוס סיסמה לא נמצא בכתובת. בקשו קישור חדש מטופס "שכחתי
          סיסמה".
        </div>
        <button
          type="button"
          style={linkBtn}
          onClick={() => setSignedOutView('forgot')}
        >
          לטופס שכחתי סיסמה
        </button>
      </div>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_NEW_PASSWORD_LENGTH) {
      setError(`הסיסמה חייבת להכיל לפחות ${MIN_NEW_PASSWORD_LENGTH} תווים`);
      return;
    }
    if (password !== confirm) {
      setError('שתי הסיסמאות צריכות להיות זהות');
      return;
    }
    setSubmitting(true);
    setError(null);
    console.info('[web auth] reset submit');
    const result = await staffResetPassword(resetToken, password);
    setSubmitting(false);
    if (!result.ok) {
      console.warn('[web auth] reset rejected', { error: result.error });
      if (result.error === 'invalid_token') {
        setError(
          'הקישור לא תקף או שפג תוקפו. בקשו קישור חדש מטופס "שכחתי סיסמה".',
        );
      } else {
        setError('עדכון הסיסמה נכשל. נסו שוב.');
      }
      return;
    }
    console.info('[web auth] reset success');
    setSuccess(true);
  };

  if (success) {
    return (
      <div style={card}>
        <div style={{ fontSize: 22, fontWeight: 600, color: INK }}>הסיסמה עודכנה</div>
        <div role="status" style={successBanner}>
          הסיסמה החדשה שלך פעילה. אפשר להתחבר עכשיו עם הדוא"ל והסיסמה החדשה.
        </div>
        <button
          type="button"
          style={{ ...primaryBtn }}
          onClick={() => clearResetToken()}
        >
          לכניסה
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} style={card}>
      <div style={{ fontSize: 22, fontWeight: 600, color: INK }}>סיסמה חדשה</div>
      <div style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 18 }}>
        בחרו סיסמה חדשה לכניסה למערכת
      </div>

      <label style={labelStyle}>
        סיסמה חדשה
        <input
          style={inputStyle}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          minLength={MIN_NEW_PASSWORD_LENGTH}
        />
      </label>

      <label style={{ ...labelStyle, marginTop: 14 }}>
        אישור סיסמה
        <input
          style={inputStyle}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={submitting}
          minLength={MIN_NEW_PASSWORD_LENGTH}
        />
      </label>

      {error && (
        <div role="alert" style={errorBanner}>
          {error}
        </div>
      )}

      <button
        type="submit"
        style={{
          ...primaryBtn,
          opacity: submitting ? 0.6 : 1,
          cursor: submitting ? 'default' : 'pointer',
        }}
        disabled={submitting}
      >
        {submitting ? 'מעדכן…' : 'עדכון סיסמה'}
      </button>

      <button
        type="button"
        style={linkBtn}
        onClick={() => clearResetToken()}
      >
        ביטול וחזרה לכניסה
      </button>
    </form>
  );
}

function humanizeLoginError(code: string): string {
  if (code === 'invalid_credentials') return 'דוא"ל או סיסמה שגויים';
  if (code === 'invalid_body') return 'אחד השדות לא תקין';
  if (code === 'session_unavailable')
    return 'החיבור הצליח אבל לא נטענו פרטי המשתמש. רעננו ונסו שוב.';
  return 'התחברות נכשלה. נסו שוב.';
}
