import { type CSSProperties, useEffect, useState } from 'react';
import { searchCustomers, type Customer } from '../lib/api/customers';
import type { CardDetailCard } from '../lib/api/cards';

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

type LightCard = Pick<
  CardDetailCard,
  'serialNumber' | 'usedEntries' | 'totalEntries' | 'customerFirstName' | 'customerLastName' | 'customerNumber'
>;

interface Props {
  card: LightCard;
  /** Customer id of the current owner — filtered out of search results. */
  currentCustomerId: string;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (newCustomerId: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Admin reassign-card flow. Lets the admin search for a customer by name /
 * phone / customer number, pick one, and confirm the reassign. The modal
 * always warns that entries + counters move with the card.
 */
export function ReassignCardModal({
  card,
  currentCustomerId,
  submitting,
  error,
  onClose,
  onConfirm,
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Customer | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      const res = await searchCustomers(q, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSearching(false);
      if (res.ok) {
        setResults(res.data.results.filter((c) => c.id !== currentCustomerId));
      } else {
        setResults([]);
        setSearchError(res.error);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, currentCustomerId]);

  const currentLabel =
    card.customerFirstName || card.customerLastName
      ? `${card.customerFirstName ?? ''} ${card.customerLastName ?? ''}`.trim()
      : 'לקוח לא ידוע';

  return (
    <div style={overlayStyle} onClick={() => !submitting && onClose()}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 600, color: INK }}>העברת כרטיסייה</div>
        <div style={{ fontSize: 13.5, color: MUTED, marginTop: 6 }}>
          {card.serialNumber} · {currentLabel}
          {card.customerNumber ? ` (${card.customerNumber})` : ''} · ניצול {card.usedEntries}/
          {card.totalEntries}
        </div>

        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            background: '#fff7d8',
            border: '1px solid #f0e1a8',
            borderRadius: 10,
            fontSize: 13,
            color: '#8a6a18',
            lineHeight: 1.5,
          }}
        >
          ההיסטוריה והניצול נשארים על הכרטיסייה. הבעלים החדש יורש את המצב כפי שהוא.
        </div>

        {picked ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13.5, color: MUTED }}>נבחר:</div>
            <div
              style={{
                marginTop: 6,
                padding: '12px 14px',
                background: '#fff4ee',
                border: '1.5px solid #ffd5b9',
                borderRadius: 10,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: INK }}>
                  {picked.firstName} {picked.lastName}
                </div>
                <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                  {picked.phone} · {picked.customerNumber}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPicked(null)}
                disabled={submitting}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: MUTED,
                  fontSize: 13,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                שנה
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חיפוש לקוח (שם, טלפון או מספר)…"
              style={inputStyle}
              disabled={submitting}
            />
            <div style={{ marginTop: 10, maxHeight: 200, overflowY: 'auto' }}>
              {searching && (
                <div style={{ color: MUTED, fontSize: 13.5, padding: '6px 4px' }}>מחפש…</div>
              )}
              {searchError && (
                <div style={{ color: '#a23a3a', fontSize: 13.5, padding: '6px 4px' }}>
                  שגיאת חיפוש.
                </div>
              )}
              {!searching && query.trim() && results.length === 0 && !searchError && (
                <div style={{ color: MUTED, fontSize: 13.5, padding: '6px 4px' }}>
                  לא נמצאו לקוחות מתאימים.
                </div>
              )}
              {results.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setPicked(c)}
                  disabled={submitting}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'right',
                    background: '#fff',
                    border: '1px solid #f3efea',
                    borderRadius: 10,
                    padding: '10px 12px',
                    marginBottom: 6,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600, color: INK, fontSize: 14 }}>
                    {c.firstName} {c.lastName}
                  </div>
                  <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                    {c.phone} · {c.customerNumber}
                  </div>
                </button>
              ))}
            </div>
          </div>
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
            onClick={() => picked && onConfirm(picked.id)}
            disabled={submitting || !picked}
            style={{
              ...primaryBtn,
              opacity: submitting || !picked ? 0.5 : 1,
              cursor: submitting || !picked ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'מעביר…' : 'אישור העברה'}
          </button>
        </div>
      </div>
    </div>
  );
}
