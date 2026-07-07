import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardLiveRound } from '../lib/api/admin';
import { createCustomer, searchCustomers, type Customer } from '../lib/api/customers';
import {
  addWalkIn,
  listRoundAttendees,
  moveBooking,
  removeBooking,
  type RoundAttendee,
} from '../lib/api/round-participants';
import { card, INK, MUTED, ORANGE } from './reports/shared';

// ---------------------------------------------------------------------------
// Round participant panel (Yanay 2026-07-07). Opens under a round tile on the
// admin live dashboard and lists who's in the round, split into the ones who
// registered and the ones a staffer added by hand (source='manual'). From here
// admin can: remove someone (refund paid / return the punch entry), move an
// early/late arrival to another round, and add a walk-in even when the round is
// full. Every action refreshes the dashboard so occupancy stays truthful.
// ---------------------------------------------------------------------------

const ghostBtn: CSSProperties = {
  background: '#fff',
  color: MUTED,
  border: '1.5px solid #e9e0d9',
  borderRadius: 9,
  fontWeight: 600,
  padding: '6px 12px',
  fontSize: 12.5,
  cursor: 'pointer',
};
const primaryBtn: CSSProperties = {
  background: ORANGE,
  color: '#fff',
  border: 'none',
  borderRadius: 9,
  fontWeight: 600,
  padding: '8px 14px',
  fontSize: 13,
  cursor: 'pointer',
};

const ticketLabel = (t: RoundAttendee['ticketType']): string =>
  t === 'child_under_walking' ? 'תינוק' : 'ילד/ה';

function removeError(code: string): string {
  if (code === 'not_confirmed') return 'ההזמנה כבר בוטלה או נוצלה — רעננו.';
  if (code === 'refund_failed')
    return 'ההחזר הכספי לא אושר — המקום נשמר ולא בוטל דבר. בדקו את WooCommerce ונסו שוב.';
  if (code === 'forbidden') return 'רק אדמין יכול להסיר משתתף.';
  return 'ההסרה נכשלה. נסו שוב.';
}

function moveError(code: string): string {
  if (code === 'target_full') return 'הסבב שנבחר מלא. אפשר להוסיף כ"נוסף ידנית" מעל התפוסה.';
  if (code === 'target_closed') return 'הסבב שנבחר סגור.';
  if (code === 'not_confirmed') return 'לא ניתן להעביר הזמנה זו.';
  return 'ההעברה נכשלה. נסו שוב.';
}

export function RoundAttendeesPanel({
  round,
  roundsToday,
  onClose,
  onChanged,
}: {
  round: DashboardLiveRound;
  roundsToday: DashboardLiveRound[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [attendees, setAttendees] = useState<RoundAttendee[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [removeFor, setRemoveFor] = useState<string | null>(null);
  const [addingWalkIn, setAddingWalkIn] = useState(false);

  const load = useCallback(async () => {
    const res = await listRoundAttendees(round.roundInstanceId);
    if (res.ok) {
      setAttendees(res.data.attendees);
      setLoadError(null);
    } else {
      setLoadError(res.error);
      console.warn('[admin round panel] load failed', { error: res.error });
    }
  }, [round.roundInstanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterChange = async (msg: string) => {
    setFlash(msg);
    await load();
    onChanged();
    setTimeout(() => setFlash(null), 4500);
  };

  const doRemove = async (a: RoundAttendee) => {
    setRowBusy(a.bookingId);
    setRowError(null);
    console.info('[admin round panel] remove', { bookingId: a.bookingId, source: a.source });
    const res = await removeBooking(a.bookingId);
    setRowBusy(null);
    setRemoveFor(null);
    if (!res.ok) {
      setRowError(removeError(res.error));
      return;
    }
    const bits: string[] = [];
    if (res.data.refunded) bits.push(`הוחזרו ₪${res.data.refundAmountIls}`);
    if (res.data.punchReturned) bits.push('כניסה הוחזרה לכרטיסייה');
    await afterChange(`${a.firstName} הוסר/ה מהסבב${bits.length ? ' · ' + bits.join(' · ') : ''}`);
  };

  const doMove = async (a: RoundAttendee, targetRoundInstanceId: string) => {
    setRowBusy(a.bookingId);
    setRowError(null);
    console.info('[admin round panel] move', { bookingId: a.bookingId, targetRoundInstanceId });
    const res = await moveBooking(a.bookingId, targetRoundInstanceId);
    setRowBusy(null);
    setMoveFor(null);
    if (!res.ok) {
      setRowError(moveError(res.error));
      return;
    }
    const target = roundsToday.find((r) => r.roundInstanceId === targetRoundInstanceId);
    await afterChange(`${a.firstName} הועבר/ה ל${target?.label ?? 'סבב אחר'}`);
  };

  const moveTargets = useMemo(
    () => roundsToday.filter((r) => r.roundInstanceId !== round.roundInstanceId && !r.isClosed),
    [roundsToday, round.roundInstanceId],
  );

  const registered = attendees?.filter((a) => a.source !== 'manual') ?? [];
  const walkIns = attendees?.filter((a) => a.source === 'manual') ?? [];

  const renderRow = (a: RoundAttendee) => (
    <div
      key={a.bookingId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        background: '#faf6f1',
        border: '1px solid #eadfd4',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
            {a.firstName} {a.lastName}
            {a.arrived && (
              <span style={{ marginInlineStart: 8, fontSize: 11.5, fontWeight: 600, color: '#0f9d58' }}>
                · הגיע/ה
              </span>
            )}
            {a.source === 'manual' && (
              <span
                style={{
                  marginInlineStart: 8,
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#b9772a',
                  background: '#fdf3e3',
                  borderRadius: 999,
                  padding: '1px 8px',
                }}
              >
                נוסף/ה ידנית
              </span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
            {a.phone} · {ticketLabel(a.ticketType)}
            {a.additionalCompanions > 0 && ' · מלווה נוסף'}
            {a.bookingNumber && ` · ${a.bookingNumber}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            type="button"
            disabled={rowBusy === a.bookingId || moveTargets.length === 0}
            style={ghostBtn}
            title={moveTargets.length === 0 ? 'אין סבב אחר פתוח היום' : undefined}
            onClick={() => {
              setRowError(null);
              setRemoveFor(null);
              setMoveFor(moveFor === a.bookingId ? null : a.bookingId);
            }}
          >
            העברה לסבב אחר
          </button>
          <button
            type="button"
            disabled={rowBusy === a.bookingId}
            style={{ ...ghostBtn, color: '#a23a3a', borderColor: '#eddad3' }}
            onClick={() => {
              setRowError(null);
              setMoveFor(null);
              setRemoveFor(removeFor === a.bookingId ? null : a.bookingId);
            }}
          >
            הסרה
          </button>
        </div>
      </div>

      {moveFor === a.bookingId && (
        <div style={{ borderTop: '1px solid #eadfd4', paddingTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12.5, color: MUTED }}>העברה אל:</span>
          {moveTargets.map((t) => (
            <button
              key={t.roundInstanceId}
              type="button"
              disabled={rowBusy === a.bookingId}
              style={ghostBtn}
              onClick={() => void doMove(a, t.roundInstanceId)}
            >
              {t.label} {t.startTime}
            </button>
          ))}
        </div>
      )}

      {removeFor === a.bookingId && (
        <div style={{ borderTop: '1px solid #eddad3', paddingTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5, color: INK }}>
            להסיר את {a.firstName}?{' '}
            {a.source === 'paid' && 'הכסף יוחזר אוטומטית ב-WooCommerce. '}
            {a.source === 'punchcard' && 'הכניסה תוחזר לכרטיסייה. '}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              disabled={rowBusy === a.bookingId}
              style={{ ...ghostBtn, background: '#c0554b', color: '#fff', border: 'none' }}
              onClick={() => void doRemove(a)}
            >
              {rowBusy === a.bookingId ? 'מסיר…' : 'כן, הסירו'}
            </button>
            <button type="button" disabled={rowBusy === a.bookingId} style={ghostBtn} onClick={() => setRemoveFor(null)}>
              ביטול
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ ...card, marginTop: 4, borderColor: '#e7d9c8' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>
          משתתפי {round.label}
          <span style={{ color: MUTED, fontWeight: 400, marginInlineStart: 8, fontSize: 13 }}>
            {round.startTime}–{round.endTime} · {round.taken}/{round.capacity}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!addingWalkIn && (
            <button type="button" style={primaryBtn} onClick={() => setAddingWalkIn(true)}>
              + הוספת משתתף
            </button>
          )}
          <button type="button" style={ghostBtn} onClick={onClose}>
            סגירה
          </button>
        </div>
      </div>

      {flash && (
        <div style={{ marginTop: 10, fontSize: 13, color: '#0f7a44', background: '#eef7ee', borderRadius: 9, padding: '8px 12px' }}>
          {flash}
        </div>
      )}
      {rowError && (
        <div style={{ marginTop: 10, fontSize: 13, color: '#a23a3a', background: '#fdf0ee', borderRadius: 9, padding: '8px 12px' }}>
          {rowError}
        </div>
      )}

      {addingWalkIn && (
        <WalkInForm
          roundInstanceId={round.roundInstanceId}
          onCancel={() => setAddingWalkIn(false)}
          onAdded={async (name, over) => {
            setAddingWalkIn(false);
            await afterChange(`${name} נוסף/ה לסבב${over ? ' · מעל התפוסה' : ''}`);
          }}
        />
      )}

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loadError ? (
          <div style={{ color: '#a23a3a', fontSize: 13 }}>
            {loadError === 'forbidden' ? 'אין הרשאה לצפות במשתתפים.' : 'לא ניתן לטעון את המשתתפים. נסו שוב.'}
          </div>
        ) : !attendees ? (
          <div style={{ color: MUTED, fontSize: 13, textAlign: 'center' }}>טוען…</div>
        ) : attendees.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13, textAlign: 'center' }}>אין עדיין משתתפים בסבב הזה.</div>
        ) : (
          <>
            {registered.map(renderRow)}
            {walkIns.length > 0 && (
              <>
                <div style={{ fontSize: 12.5, color: MUTED, fontWeight: 600, marginTop: 4 }}>
                  נוספו ידנית ({walkIns.length})
                </div>
                {walkIns.map(renderRow)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Walk-in form: search existing customer or quick-add a new one ----------

function WalkInForm({
  roundInstanceId,
  onCancel,
  onAdded,
}: {
  roundInstanceId: string;
  onCancel: () => void;
  onAdded: (customerName: string, overCapacity: boolean) => void | Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Quick-add mode for a brand-new customer.
  const [creating, setCreating] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Debounced search — 2+ chars, latest request wins.
  useEffect(() => {
    if (creating) return;
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const res = await searchCustomers(term, { signal: ctrl.signal });
      if (res.ok) setResults(res.data.results);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q, creating]);

  const add = async (customerId: string, name: string) => {
    setBusy(true);
    setError(null);
    console.info('[admin round panel] walk-in add', { roundInstanceId, customerId });
    const res = await addWalkIn(roundInstanceId, { customerId });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error === 'round_full'
          ? 'הסבב מלא והוספה מעל התפוסה כבויה בהגדרות.'
          : res.error === 'round_closed'
            ? 'הסבב סגור.'
            : 'ההוספה נכשלה. נסו שוב.',
      );
      return;
    }
    await onAdded(name, res.data.overCapacity);
  };

  const quickAdd = async () => {
    if (!first.trim() || !phone.trim()) return;
    setBusy(true);
    setError(null);
    console.info('[admin round panel] walk-in quick-create', { phone: phone.trim() });
    const created = await createCustomer({ firstName: first.trim(), lastName: last.trim(), phone: phone.trim() });
    if (!created.ok) {
      setBusy(false);
      setError('יצירת הלקוח נכשלה — בדקו את הטלפון (ייתכן שכבר קיים).');
      return;
    }
    setBusy(false);
    await add(created.data.customer.id, created.data.customer.firstName);
  };

  const inputStyle: CSSProperties = {
    padding: '8px 10px',
    borderRadius: 9,
    border: '1.5px solid #e9e0d9',
    fontSize: 13.5,
    width: '100%',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ marginTop: 12, border: '1px solid #e7d9c8', borderRadius: 10, padding: 12, background: '#fffdf9' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>
          {creating ? 'לקוח חדש' : 'הוספת משתתף — חיפוש לקוח'}
        </span>
        <button
          type="button"
          style={{ ...ghostBtn, padding: '4px 10px' }}
          onClick={() => {
            setCreating(!creating);
            setError(null);
          }}
        >
          {creating ? 'חזרה לחיפוש' : 'לקוח חדש'}
        </button>
      </div>

      {error && <div style={{ fontSize: 12.5, color: '#a23a3a', marginBottom: 8 }}>{error}</div>}

      {creating ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input placeholder="שם פרטי" value={first} onChange={(e) => setFirst(e.target.value)} style={inputStyle} />
            <input placeholder="שם משפחה" value={last} onChange={(e) => setLast(e.target.value)} style={inputStyle} />
          </div>
          <input placeholder="טלפון" value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} inputMode="tel" />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              disabled={busy || !first.trim() || !phone.trim()}
              style={{ ...primaryBtn, opacity: !first.trim() || !phone.trim() ? 0.5 : 1 }}
              onClick={() => void quickAdd()}
            >
              {busy ? 'מוסיף…' : 'יצירה והוספה לסבב'}
            </button>
            <button type="button" disabled={busy} style={ghostBtn} onClick={onCancel}>
              ביטול
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            placeholder="שם, טלפון או מספר לקוח…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={inputStyle}
            autoFocus
          />
          {searching && <div style={{ fontSize: 12.5, color: MUTED }}>מחפש…</div>}
          {!searching && q.trim().length >= 2 && results.length === 0 && (
            <div style={{ fontSize: 12.5, color: MUTED }}>
              לא נמצאו לקוחות. אפשר ליצור לקוח חדש למעלה.
            </div>
          )}
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              style={{
                ...ghostBtn,
                width: '100%',
                textAlign: 'right',
                padding: '9px 12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              onClick={() => void add(c.id, c.firstName)}
            >
              <span style={{ fontWeight: 600, color: INK }}>
                {c.firstName} {c.lastName}
              </span>
              <span style={{ color: MUTED, fontSize: 12 }}>
                {c.phone} · {c.customerNumber}
              </span>
            </button>
          ))}
          <button type="button" disabled={busy} style={{ ...ghostBtn, alignSelf: 'flex-start' }} onClick={onCancel}>
            ביטול
          </button>
        </div>
      )}
    </div>
  );
}
