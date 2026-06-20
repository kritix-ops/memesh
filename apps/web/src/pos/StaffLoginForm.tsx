import { useState, type CSSProperties, type FormEvent } from 'react';
import { Sun } from '../brand';
import { useStaffSession } from '../lib/staff-session';

const ORANGE = '#ffa983';
const INK = '#2d3436';
const MUTED = '#636e72';
const SHADOW = '0 4px 20px rgba(0,0,0,0.08)';

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

const errorBanner: CSSProperties = {
  marginTop: 16,
  padding: '10px 14px',
  background: '#fbecec',
  color: '#a23a3a',
  borderRadius: 10,
  fontSize: 14,
};

export function StaffLoginForm() {
  const { signIn } = useStaffSession();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedPhone = phone.trim();
    if (!trimmedPhone || !password) {
      setError('נא למלא טלפון וסיסמה');
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await signIn(trimmedPhone, password);
    setSubmitting(false);
    if (!result.ok) {
      setError(humanizeError(result.error));
    }
  };

  return (
    <main style={{ maxWidth: 420, margin: '0 auto', padding: '56px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
        <Sun size={56} />
      </div>
      <form onSubmit={onSubmit} style={card}>
        <div style={{ fontSize: 22, fontWeight: 600, color: INK }}>כניסת צוות</div>
        <div style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 18 }}>
          הזינו טלפון וסיסמה כדי להמשיך
        </div>

        <label style={labelStyle}>
          טלפון
          <input
            style={inputStyle}
            type="tel"
            inputMode="tel"
            autoComplete="username"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="050-000-0000"
            disabled={submitting}
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
      </form>
    </main>
  );
}

function humanizeError(code: string): string {
  if (code === 'invalid_credentials') return 'טלפון או סיסמה שגויים';
  if (code === 'invalid_body') return 'אחד השדות לא תקין';
  if (code === 'session_unavailable')
    return 'החיבור הצליח אבל לא נטענו פרטי המשתמש. רעננו ונסו שוב.';
  return 'התחברות נכשלה. נסו שוב.';
}
