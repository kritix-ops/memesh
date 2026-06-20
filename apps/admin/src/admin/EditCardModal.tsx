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

// Local copy of YYYY-MM-DD <input type="date"> helpers — keeps this modal
// dependency-free of the reports utilities.
const toDateInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export type CardEditTarget = {
  id: string;
  serialNumber: string;
  totalEntries: number;
  usedEntries: number;
  source: 'pos' | 'online' | 'manual';
  expiresAt: string | null;
};

export interface EditCardSubmit {
  totalEntries?: number;
  source?: 'pos' | 'online' | 'manual';
  /** undefined = keep, null = forever, "YYYY-MM-DD" = set */
  expiresAt?: string | null;
}

interface Props {
  card: CardEditTarget;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (input: EditCardSubmit) => void;
}

/**
 * Admin direct edit of an existing card. Surfaces three editable fields:
 * total entries, source, and expiry (with a "ללא תפוגה" toggle). Used
 * entries are not editable here — use the refund flow for that.
 */
export function EditCardModal({ card, submitting, error, onClose, onConfirm }: Props) {
  const [total, setTotal] = useState(String(card.totalEntries));
  const [source, setSource] = useState<'pos' | 'online' | 'manual'>(card.source);
  const [forever, setForever] = useState(card.expiresAt === null);
  const [expiry, setExpiry] = useState(
    card.expiresAt === null ? '' : toDateInput(card.expiresAt),
  );

  const totalN = Number(total);
  const totalValid = Number.isInteger(totalN) && totalN >= 1 && totalN <= 1000;
  const totalAtOrAboveUsed = totalValid && totalN >= card.usedEntries;
  const expiryValid = forever || /^\d{4}-\d{2}-\d{2}$/.test(expiry);

  const dirty =
    totalN !== card.totalEntries ||
    source !== card.source ||
    (forever && card.expiresAt !== null) ||
    (!forever && expiry !== toDateInput(card.expiresAt));

  const canSubmit =
    !submitting && totalValid && totalAtOrAboveUsed && expiryValid && dirty;

  const submit = () => {
    const patch: EditCardSubmit = {};
    if (totalN !== card.totalEntries) patch.totalEntries = totalN;
    if (source !== card.source) patch.source = source;
    if (forever && card.expiresAt !== null) patch.expiresAt = null;
    else if (!forever && expiry !== toDateInput(card.expiresAt)) patch.expiresAt = expiry;
    onConfirm(patch);
  };

  return (
    <div style={overlayStyle} onClick={() => !submitting && onClose()}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 600, color: INK }}>עריכת כרטיסייה</div>
        <div style={{ fontSize: 13.5, color: MUTED, marginTop: 6 }}>
          {card.serialNumber} · ניצול נוכחי: {card.usedEntries} / {card.totalEntries}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13.5, color: MUTED }}>סה״כ כניסות</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              disabled={submitting}
              style={inputStyle}
            />
            {!totalAtOrAboveUsed && totalValid && (
              <span style={{ fontSize: 12.5, color: '#a23a3a' }}>
                לא ניתן לקבוע מתחת ל-{card.usedEntries} (מספר הכניסות שנוצלו). להחזר כניסות — השתמשו בלחצן ״החזר״ בהיסטוריה.
              </span>
            )}
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13.5, color: MUTED }}>תאריך תפוגה</span>
            <input
              type="date"
              value={forever ? '' : expiry}
              onChange={(e) => setExpiry(e.target.value)}
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

        <div
          style={{
            marginTop: 14,
            padding: '10px 12px',
            background: '#fff8f3',
            border: '1px solid #ffe3d4',
            borderRadius: 10,
            fontSize: 12.5,
            color: '#a8643d',
            lineHeight: 1.5,
          }}
        >
          הגדלת ״סה״כ כניסות״ על כרטיסייה שמוצתה תפעיל אותה מחדש אוטומטית. הקטנה
          לערך השווה לכמות שנוצלה תסגור את הכרטיסייה (מצוב מצוצתה).
        </div>

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
            onClick={submit}
            disabled={!canSubmit}
            style={{
              ...primaryBtn,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'שומר…' : 'שמור שינויים'}
          </button>
        </div>
      </div>
    </div>
  );
}
