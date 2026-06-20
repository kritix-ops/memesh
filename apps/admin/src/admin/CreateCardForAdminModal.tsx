import { type CSSProperties, useState } from 'react';
import type { Customer } from '../lib/api/customers';
import type { CardSettings } from '../lib/api/card-settings';

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
  width: 460,
  maxWidth: '100%',
  maxHeight: '90vh',
  overflowY: 'auto',
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
  padding: '11px 20px',
  fontSize: 15,
  cursor: 'pointer',
};

const primaryBtn: CSSProperties = {
  background: ORANGE,
  color: '#fff',
  border: 'none',
  borderRadius: 10,
  fontWeight: 600,
  padding: '11px 20px',
  fontSize: 15,
  cursor: 'pointer',
};

export type AdminCreateInput = {
  totalEntries: number;
  /** null = forever, N = N days. */
  validityDays: number | null;
  source: 'pos' | 'online' | 'manual';
};

interface Props {
  customer: Customer;
  defaults: Pick<CardSettings, 'totalEntries' | 'validityDays'>;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (input: AdminCreateInput) => void;
}

/**
 * Admin form to create a card for a specific customer with full overrides:
 * total entries, validity (with "forever" toggle), and source. Used by
 * admins from the customer-detail screen.
 */
export function CreateCardForAdminModal({
  customer,
  defaults,
  submitting,
  error,
  onClose,
  onConfirm,
}: Props) {
  const [entries, setEntries] = useState(String(defaults.totalEntries));
  const [forever, setForever] = useState(defaults.validityDays === 0);
  const [days, setDays] = useState(
    defaults.validityDays === 0 ? '365' : String(defaults.validityDays),
  );
  const [source, setSource] = useState<'manual' | 'pos' | 'online'>('manual');

  const submit = () => {
    const eNum = Number(entries);
    if (!Number.isInteger(eNum) || eNum < 1 || eNum > 100) return;
    if (!forever) {
      const d = Number(days);
      if (!Number.isInteger(d) || d < 1 || d > 3650) return;
    }
    onConfirm({
      totalEntries: eNum,
      validityDays: forever ? null : Number(days),
      source,
    });
  };

  const canSubmit =
    !submitting &&
    Number.isInteger(Number(entries)) &&
    Number(entries) >= 1 &&
    (forever || (Number.isInteger(Number(days)) && Number(days) >= 1));

  return (
    <div style={overlayStyle} onClick={() => !submitting && onClose()}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 600, color: INK }}>הנפקת כרטיסייה</div>
        <div style={{ fontSize: 13.5, color: MUTED, marginTop: 6 }}>
          ל-<b>{customer.firstName} {customer.lastName}</b> · {customer.phone}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13.5, color: MUTED }}>כניסות בכרטיסייה</span>
            <input
              type="number"
              inputMode="numeric"
              value={entries}
              onChange={(e) => setEntries(e.target.value)}
              disabled={submitting}
              style={inputStyle}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13.5, color: MUTED }}>תוקף (ימים)</span>
            <input
              type="number"
              inputMode="numeric"
              value={forever ? '' : days}
              onChange={(e) => setDays(e.target.value)}
              disabled={submitting || forever}
              style={inputStyle}
            />
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              border: '1px solid #f3efea',
              borderRadius: 10,
              fontSize: 13.5,
              color: INK,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={forever}
              onChange={(e) => setForever(e.target.checked)}
              disabled={submitting}
            />
            ללא תפוגה (כרטיסייה לכל החיים)
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13.5, color: MUTED }}>מקור</span>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              disabled={submitting}
              style={{ ...inputStyle, paddingInlineEnd: 32 }}
            >
              <option value="manual">ידני (אדמין)</option>
              <option value="pos">קופה</option>
              <option value="online">אונליין</option>
            </select>
          </label>
        </div>

        {error && (
          <div
            role="alert"
            style={{
              marginTop: 14,
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
            onClick={submit}
            disabled={!canSubmit}
            style={{
              ...primaryBtn,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'יוצר…' : 'צור כרטיסייה'}
          </button>
        </div>
      </div>
    </div>
  );
}
