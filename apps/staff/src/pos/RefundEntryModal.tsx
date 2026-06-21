import { type CSSProperties, useState } from 'react';

const ORANGE = '#ffa983';
const INK = '#2d3436';
const MUTED = '#636e72';
const SHADOW = '0 4px 20px rgba(0,0,0,0.08)';

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(45,52,54,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  zIndex: 60,
};

const panelStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 24,
  width: 420,
  maxWidth: '100%',
  animation: 'memesh-rise 0.25s ease',
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

const ghostBtn: CSSProperties = {
  background: '#fff',
  color: MUTED,
  border: '1.5px solid #e9e0d9',
  borderRadius: 10,
  fontWeight: 600,
  padding: '12px 22px',
  fontSize: 15,
  cursor: 'pointer',
};

const primaryBtn: CSSProperties = {
  background: ORANGE,
  color: '#fff',
  border: 'none',
  borderRadius: 10,
  fontWeight: 600,
  padding: '12px 22px',
  fontSize: 15,
  cursor: 'pointer',
};

interface Props {
  /** Display-only summary of the entry being refunded (date + entries-consumed count). */
  entrySummary: string;
  /** When true the modal hides the admin password field — admin approves themselves. */
  selfApprove: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string, adminPassword: string | undefined) => void;
}

/**
 * Refund-entry modal. Always asks for a reason; additionally asks for an
 * admin password unless the signed-in user is themselves an admin
 * (`selfApprove`). Pure UI — the parent owns the API call.
 */
export function RefundEntryModal({
  entrySummary,
  selfApprove,
  submitting,
  error,
  onClose,
  onConfirm,
}: Props) {
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const trimmed = reason.trim();
  const canSubmit =
    !submitting &&
    trimmed.length >= 1 &&
    (selfApprove || password.length >= 1);

  return (
    <div
      style={overlayStyle}
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 600, color: INK }}>החזר כניסה</div>
        <div style={{ fontSize: 13.5, color: MUTED, marginTop: 6 }}>{entrySummary}</div>
        <div
          style={{
            marginTop: 14,
            padding: '10px 12px',
            background: '#fff8f3',
            border: '1px solid #ffe3d4',
            borderRadius: 10,
            fontSize: 13,
            color: '#a8643d',
            lineHeight: 1.5,
          }}
        >
          הכניסה תוחזר לכרטיסייה והניצול יחזור אחורה.
          {!selfApprove && ' להחזר נדרש אישור אדמין.'}
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
          <span style={{ fontSize: 13.5, color: MUTED }}>סיבת ההחזר *</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            rows={3}
            maxLength={500}
            placeholder="לדוגמה: הלקוח עזב מיד אחרי הניקוב"
            style={{ ...inputStyle, resize: 'vertical', minHeight: 64, fontFamily: 'inherit' }}
          />
        </label>

        {!selfApprove && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            <span style={{ fontSize: 13.5, color: MUTED }}>סיסמת אדמין *</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              placeholder="אדמין מקליד/ה כאן את הסיסמא"
              style={inputStyle}
            />
            <span style={{ fontSize: 12.5, color: MUTED }}>
              הסיסמא נשלחת לשרת ונבדקת מול כל האדמינים הפעילים. אינה נשמרת.
            </span>
          </label>
        )}

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
            onClick={() => onConfirm(trimmed, selfApprove ? undefined : password)}
            disabled={!canSubmit}
            style={{
              ...primaryBtn,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'מחזיר…' : 'אישור החזר'}
          </button>
        </div>
      </div>
    </div>
  );
}
