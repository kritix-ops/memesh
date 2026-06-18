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
  zIndex: 50,
};

const panelStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 24,
  width: 360,
  maxWidth: '100%',
  animation: 'memesh-rise 0.25s ease',
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

const stepBtnStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 12,
  border: '1.5px solid #e9e0d9',
  background: '#fff',
  fontSize: 24,
  color: INK,
  cursor: 'pointer',
};

const companionLabel = (n: number): string => (n === 1 ? 'מלווה אחד' : `${n} מלווים`);

interface Props {
  /** Called when the user dismisses (overlay click or "ביטול"). */
  onClose: () => void;
  /** Called with the chosen companion count when the user taps "נקב". */
  onConfirm: (companions: number) => void;
  /** True while the parent is awaiting the punch response — disables the buttons. */
  submitting: boolean;
}

/**
 * Companion-count picker + confirm. Lives over the customer detail screen
 * when the cashier taps "ניקוב כניסה". The parent owns the idempotency key
 * and the punch call; this component is pure UI.
 */
export function PunchConfirmModal({ onClose, onConfirm, submitting }: Props) {
  const [companions, setCompanions] = useState(1);

  return (
    <div
      style={overlayStyle}
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 600, textAlign: 'center', color: INK }}>
          כמה מלווים?
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 18,
            marginTop: 18,
          }}
        >
          <button
            style={stepBtnStyle}
            onClick={() => setCompanions((n) => Math.max(1, n - 1))}
            disabled={submitting}
            aria-label="פחות מלווים"
          >
            −
          </button>
          <div style={{ textAlign: 'center', minWidth: 100 }}>
            <div style={{ fontSize: 44, fontWeight: 600, color: ORANGE, lineHeight: 1 }}>
              {companions}
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
              {companionLabel(companions)}
            </div>
          </div>
          <button
            style={stepBtnStyle}
            onClick={() => setCompanions((n) => Math.min(4, n + 1))}
            disabled={submitting}
            aria-label="עוד מלווים"
          >
            +
          </button>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button
            style={{ ...ghostBtn, flex: 1, opacity: submitting ? 0.5 : 1 }}
            onClick={onClose}
            disabled={submitting}
          >
            ביטול
          </button>
          <button
            style={{ ...primaryBtn, flex: 1, opacity: submitting ? 0.7 : 1 }}
            onClick={() => onConfirm(companions)}
            disabled={submitting}
          >
            {submitting ? 'מנקב…' : 'נקב'}
          </button>
        </div>
      </div>
    </div>
  );
}
