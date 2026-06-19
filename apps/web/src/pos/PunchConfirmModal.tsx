import { type CSSProperties, useState } from 'react';
import type { ScanLookupResponse } from '../lib/api/punch';

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
  width: 420,
  maxWidth: '100%',
  maxHeight: '90vh',
  overflowY: 'auto',
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

const fullName = (c: ScanLookupResponse['customer']): string =>
  `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'לקוח לא ידוע';

const initialsOf = (c: ScanLookupResponse['customer']): string =>
  (c.firstName?.[0] ?? '') + (c.lastName?.[0] ?? '') || '?';

const fmtDay = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtDayShort = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
};
const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Status banner copy — surfaces *why* the cashier cannot punch so they can
// tell the customer at the counter without guessing.
const statusMessage = (preview: ScanLookupResponse): string => {
  if (preview.status === 'cancelled') {
    const date = preview.card.cancelledAt ? ` ב-${fmtDay(preview.card.cancelledAt)}` : '';
    const reason = preview.card.cancelReason ? ` · סיבה: ${preview.card.cancelReason}` : '';
    return `הכרטיסייה בוטלה${date}${reason}`;
  }
  if (preview.status === 'exhausted') return 'הכרטיסייה נוצלה במלואה — אין כניסות נוספות';
  if (preview.status === 'expired')
    return `הכרטיסייה פגת תוקף (פגה ב-${fmtDay(preview.card.expiresAt)})`;
  return '';
};

interface Props {
  /** Called when the user dismisses (overlay click or "ביטול"/"סגור"). */
  onClose: () => void;
  /**
   * Called with the chosen companion count when the user taps "נקב".
   * Not called when the modal is rendered for a non-ok preview status.
   */
  onConfirm: (companions: number) => void;
  /** True while the parent is awaiting the punch response — disables the buttons. */
  submitting: boolean;
  /**
   * Optional preview block. Present in the scan flow so the cashier can see
   * who and what they are about to punch. Omitted in the customer-detail
   * flow because the customer is already on screen. When the preview's
   * `status !== 'ok'`, the companion picker is hidden and the primary
   * action becomes "סגור".
   */
  preview?: ScanLookupResponse;
}

/**
 * Companion-count picker + confirm, optionally fronted by a customer +
 * card preview block. The parent owns the idempotency key and the punch
 * call; this component is pure UI.
 */
export function PunchConfirmModal({ onClose, onConfirm, submitting, preview }: Props) {
  const [companions, setCompanions] = useState(1);

  const canPunch = !preview || preview.status === 'ok';
  const remaining = preview ? preview.card.totalEntries - preview.card.usedEntries : 0;
  const lastEntry = preview?.entries[0];

  return (
    <div
      style={overlayStyle}
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {preview && <PreviewBlock preview={preview} remaining={remaining} lastEntry={lastEntry} />}

        {preview && !canPunch && (
          <div
            role="alert"
            style={{
              background: '#fbecec',
              color: '#a23a3a',
              borderRadius: 10,
              padding: '12px 14px',
              fontSize: 14,
              fontWeight: 600,
              marginTop: preview ? 16 : 0,
            }}
          >
            {statusMessage(preview)}
          </div>
        )}

        {canPunch && (
          <>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                textAlign: 'center',
                color: INK,
                marginTop: preview ? 16 : 0,
              }}
            >
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
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          {canPunch ? (
            <>
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
            </>
          ) : (
            <button style={{ ...primaryBtn, flex: 1 }} onClick={onClose}>
              סגור
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Preview block: customer identity + card progress + children + last visit
// + full punch history. Designed to fit inside the same modal as the
// companion picker so the cashier sees everything before tapping "נקב".
function PreviewBlock({
  preview,
  remaining,
  lastEntry,
}: {
  preview: ScanLookupResponse;
  remaining: number;
  lastEntry: ScanLookupResponse['entries'][number] | undefined;
}) {
  const { customer, card, entries } = preview;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            background: '#fff4ee',
            color: '#c97a52',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontSize: 17,
            flexShrink: 0,
          }}
        >
          {initialsOf(customer)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: INK }}>{fullName(customer)}</div>
          <div
            style={{
              fontSize: 13,
              color: MUTED,
              marginTop: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {customer.phone ?? '—'}
            {customer.customerNumber ? ` · ${customer.customerNumber}` : ''}
          </div>
        </div>
      </div>

      {customer.children.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {customer.children.map((k) => (
            <span
              key={k.name}
              style={{
                background: '#f3f7e8',
                color: '#6f8f37',
                borderRadius: 8,
                padding: '4px 10px',
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              {k.name}
            </span>
          ))}
        </div>
      )}

      <div
        style={{
          marginTop: 14,
          padding: '12px 14px',
          background: '#fff8f3',
          border: '1px solid #ffe3d4',
          borderRadius: 10,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          fontSize: 13.5,
        }}
      >
        <div>
          <div style={{ color: MUTED, fontSize: 12 }}>נותרו</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: ORANGE, lineHeight: 1.1 }}>
            {Math.max(0, remaining)}{' '}
            <span style={{ fontSize: 13, color: MUTED, fontWeight: 400 }}>
              מתוך {card.totalEntries}
            </span>
          </div>
        </div>
        <div>
          <div style={{ color: MUTED, fontSize: 12 }}>תוקף עד</div>
          <div style={{ fontWeight: 600, color: INK }}>{fmtDay(card.expiresAt)}</div>
        </div>
        <div style={{ gridColumn: '1 / -1', fontSize: 12, color: MUTED }}>
          {card.serialNumber}
          {lastEntry ? ` · ביקור אחרון: ${fmtDay(lastEntry.punchedAt)}` : ' · אין ביקורים עדיין'}
        </div>
      </div>

      {entries.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: MUTED, marginBottom: 6, fontWeight: 600 }}>
            היסטוריית כניסות ({entries.length})
          </div>
          <div
            style={{
              maxHeight: 140,
              overflowY: 'auto',
              border: '1px solid #f3efea',
              borderRadius: 10,
            }}
          >
            {entries.map((h, i) => {
              const who =
                h.staffFirstName || h.staffLastName
                  ? `${h.staffFirstName ?? ''} ${h.staffLastName ?? ''}`.trim()
                  : '';
              return (
                <div
                  key={h.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderTop: i ? '1px solid #f3efea' : 'none',
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: INK }}>
                    {fmtDayShort(h.punchedAt)} · {fmtTime(h.punchedAt)}
                  </span>
                  <span style={{ color: MUTED }}>
                    {companionLabel(h.companionCount)}
                    {who ? ` · ${who}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
