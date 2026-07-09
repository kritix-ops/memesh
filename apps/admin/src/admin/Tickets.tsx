import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { useStaffSession } from '@memesh/staff-auth';
import {
  fetchTicketsReport,
  type TicketsReportFilters,
  type TicketsReportRow,
  type TicketsReportSummary,
  type TicketStatus,
} from '../lib/api/reports';
import {
  listRoundsForDate,
  moveBooking,
  removeBooking,
  setTicketArrival,
  type MoveTargetRound,
} from '../lib/api/round-participants';
import { venueTodayIso } from '../lib/export';
import {
  Chip,
  ChipRow,
  EmptyState,
  Field,
  FieldRow,
  FilterBar,
  fmtDateTime,
  INK,
  inputStyle,
  LoadingState,
  MUTED,
  SearchInput,
  SectionShell,
  SelectField,
  Table,
  Td,
  ticketSourceLabel,
  ticketStatusMeta,
  ticketTypeLabel,
  type TableCol,
} from './reports/shared';

// ---------------------------------------------------------------------------
// ניהול כרטיסים — every entrance ticket (booking) across every round, in one
// searchable place (plan 2026-07-09-admin-tickets-management). The per-round
// view stays on the live dashboard; this screen answers "find THIS ticket":
// a parent calls with a booking number, a phone number, or just a name, and
// the staffer can see the ticket's story and act on it — move it to another
// round, mark arrival (today only), or remove it (admin, money-safe).
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

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

const dangerBtn: CSSProperties = {
  ...ghostBtn,
  color: '#a23a3a',
  borderColor: '#eddad3',
};

function removeError(code: string): string {
  if (code === 'not_confirmed') return 'הכרטיס כבר בוטל או נוצל — רעננו.';
  if (code === 'refund_failed')
    return 'ההחזר הכספי לא אושר — המקום נשמר ולא בוטל דבר. בדקו את WooCommerce ונסו שוב.';
  if (code === 'forbidden') return 'רק אדמין יכול להסיר כרטיס.';
  return 'ההסרה נכשלה. נסו שוב.';
}

function moveError(code: string): string {
  if (code === 'target_full') return 'הסבב שנבחר מלא.';
  if (code === 'target_closed') return 'הסבב שנבחר סגור.';
  if (code === 'not_confirmed') return 'לא ניתן להעביר כרטיס זה.';
  return 'ההעברה נכשלה. נסו שוב.';
}

function arrivalError(code: string): string {
  if (code === 'not_today') return 'סימון הגעה אפשרי רק ביום הסבב עצמו.';
  if (code === 'not_markable') return 'לא ניתן לסמן הגעה לכרטיס במצב הזה — רעננו.';
  if (code === 'not_found') return 'הכרטיס לא נמצא — רעננו.';
  return 'הפעולה נכשלה. נסו שוב.';
}

type StatusChip = '' | TicketStatus;

export function Tickets() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusChip>('confirmed');
  const [source, setSource] = useState<'' | 'paid' | 'punchcard' | 'gift' | 'manual'>('');
  // Default view: upcoming active tickets, soonest first. The from-date is a
  // visible, clearable input value — not a hidden filter.
  const [dateFrom, setDateFrom] = useState(() => venueTodayIso());
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<TicketsReportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<TicketsReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const { state: sessionState } = useStaffSession();
  const role = sessionState.status === 'signed-in' ? sessionState.user.role : null;
  const today = venueTodayIso();

  // Back to page 1 whenever the filter set changes.
  useEffect(() => {
    setPage(0);
  }, [q, status, source, dateFrom, dateTo]);

  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  useEffect(() => {
    // Sorting is server-side; a direction flip restarts at page 1 too.
    setPage(0);
  }, [sortDir]);

  const filters: TicketsReportFilters = useMemo(() => {
    const f: TicketsReportFilters = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      sort: 'date',
      sortDir,
    };
    if (q.trim()) f.q = q.trim().slice(0, 120);
    if (status) f.status = status;
    if (source) f.source = source;
    if (dateFrom) f.dateFrom = dateFrom;
    if (dateTo) f.dateTo = dateTo;
    return f;
  }, [q, status, source, dateFrom, dateTo, page, sortDir]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await fetchTicketsReport(filters);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setRows(res.data.rows);
        setTotal(res.data.total);
        setSummary(res.data.summary);
        console.info('[web tickets] load', {
          filters,
          count: res.data.rows.length,
          total: res.data.total,
        });
      } else {
        setError(res.error);
        console.warn('[web tickets] load error', { error: res.error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, reloadTick]);

  const reload = () => setReloadTick((t) => t + 1);

  // If an action shrank the result set below the current page (e.g. removing
  // the last ticket on the last page), fall back to the last real page.
  useEffect(() => {
    if (page > 0 && total > 0 && page * PAGE_SIZE >= total) {
      setPage(Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
    }
  }, [page, total]);

  const chips: { k: StatusChip; l: string; n?: number }[] = [
    { k: 'confirmed', l: 'הזמנות פעילות', ...(summary && { n: summary.confirmed }) },
    { k: 'used', l: 'הגיעו', ...(summary && { n: summary.used }) },
    { k: 'cancelled', l: 'בוטלו', ...(summary && { n: summary.cancelled }) },
    { k: 'expired', l: 'פגו', ...(summary && { n: summary.expired }) },
    { k: '', l: 'הכל' },
  ];

  const cols: TableCol<'number' | 'customer' | 'date' | 'round' | 'type' | 'source' | 'status'>[] = [
    { key: 'number', label: 'מס׳ כרטיס', width: 150 },
    { key: 'customer', label: 'לקוח' },
    { key: 'date', label: 'תאריך', width: 100, sortable: true },
    { key: 'round', label: 'סבב', width: 150 },
    { key: 'type', label: 'סוג', width: 90 },
    { key: 'source', label: 'מקור', width: 90 },
    { key: 'status', label: 'סטטוס', width: 110 },
  ];
  const onSort = () => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <SectionShell
      title="ניהול כרטיסים"
      description="כל כרטיסי הכניסה לסבבים — חיפוש לפי מספר כרטיס, שם, טלפון או מספר לקוח, עם פעולות על כל כרטיס."
    >
      <FilterBar>
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="מספר כרטיס (R-...), שם, טלפון או מספר לקוח…"
        />
        <ChipRow>
          {chips.map((c) => (
            <Chip key={c.k || 'all'} active={status === c.k} onClick={() => setStatus(c.k)}>
              {c.l}
              {c.n !== undefined && ` (${c.n})`}
            </Chip>
          ))}
        </ChipRow>
        <FieldRow>
          <Field label="מתאריך סבב">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="עד תאריך סבב">
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <SelectField
            label="מקור"
            value={source}
            onChange={setSource}
            options={[
              { value: '', label: 'הכל' },
              { value: 'paid', label: 'אתר' },
              { value: 'punchcard', label: 'כרטיסייה' },
              { value: 'gift', label: 'מתנה' },
              { value: 'manual', label: 'ידני' },
            ]}
          />
        </FieldRow>
      </FilterBar>

      {loading && !rows && <LoadingState />}
      {error && (
        <div style={{ marginTop: 14, color: '#a23a3a', fontSize: 14 }}>
          לא ניתן לטעון את הכרטיסים. נסו לרענן.
        </div>
      )}

      {rows && (
        <Table
          cols={cols}
          rows={rows}
          sortKey="date"
          sortDir={sortDir}
          onSort={onSort}
          empty={<EmptyState>אין כרטיסים תואמים לחיפוש או לסינון.</EmptyState>}
          render={(r) => (
            <TicketRow
              key={r.bookingId}
              row={r}
              today={today}
              isAdmin={role === 'admin'}
              open={openId === r.bookingId}
              onToggle={() => setOpenId(openId === r.bookingId ? null : r.bookingId)}
              onChanged={reload}
            />
          )}
        />
      )}

      {rows && total > 0 && (
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            fontSize: 13,
            color: MUTED,
          }}
        >
          <span>
            סה"כ <strong style={{ color: INK }}>{total}</strong> כרטיסים
          </span>
          {totalPages > 1 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                style={{ ...ghostBtn, opacity: page === 0 ? 0.5 : 1 }}
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ← הקודם
              </button>
              עמוד {page + 1} מתוך {totalPages}
              <button
                type="button"
                style={{ ...ghostBtn, opacity: page + 1 >= totalPages ? 0.5 : 1 }}
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                הבא →
              </button>
            </span>
          )}
        </div>
      )}
    </SectionShell>
  );
}

// --- A single ticket row + its expandable detail/actions panel --------------

function TicketRow({
  row: r,
  today,
  isAdmin,
  open,
  onToggle,
  onChanged,
}: {
  row: TicketsReportRow;
  today: string;
  isAdmin: boolean;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const meta = ticketStatusMeta(r.status, r.date, today);
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', background: open ? '#fffaf6' : undefined }}>
        <Td muted>{r.bookingNumber ?? '—'}</Td>
        <Td>
          {`${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim() || '—'}
          <div style={{ fontSize: 12, color: '#9a9a9a' }}>
            {r.customerPhone}
            {r.customerNumber && ` · ${r.customerNumber}`}
          </div>
        </Td>
        <Td muted>{r.date.split('-').reverse().join('.')}</Td>
        <Td muted>
          {r.roundLabel}
          <div style={{ fontSize: 12, color: '#9a9a9a' }}>
            {r.startTime}–{r.endTime}
          </div>
        </Td>
        <Td muted>
          {ticketTypeLabel(r.ticketType)}
          {r.additionalCompanions > 0 && (
            <div style={{ fontSize: 12, color: '#9a9a9a' }}>+ מלווה</div>
          )}
        </Td>
        <Td muted>{ticketSourceLabel(r.source)}</Td>
        <Td>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: meta.color,
              background: meta.bg,
              borderRadius: 999,
              padding: '2px 10px',
              whiteSpace: 'nowrap',
            }}
          >
            {meta.label}
          </span>
        </Td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ padding: 0, borderBottom: '1px solid #f3efea' }}>
            <TicketDetail row={r} today={today} isAdmin={isAdmin} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function TicketDetail({
  row: r,
  today,
  isAdmin,
  onChanged,
}: {
  row: TicketsReportRow;
  today: string;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [targets, setTargets] = useState<MoveTargetRound[] | null>(null);

  const isToday = r.date === today;
  const canMove = r.status === 'confirmed';
  const canMarkArrival = isToday && (r.status === 'confirmed' || r.status === 'used');
  const canRemove = isAdmin && r.status === 'confirmed';

  useEffect(() => {
    if (!moving) return;
    let cancelled = false;
    (async () => {
      const res = await listRoundsForDate(r.date);
      if (cancelled) return;
      if (res.ok) {
        setTargets(
          res.data.rounds.filter((t) => t.roundInstanceId !== r.roundInstanceId && !t.isClosed),
        );
      } else {
        setActionError('לא ניתן לטעון את סבבי היום הזה. נסו שוב.');
        setMoving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [moving, r.date, r.roundInstanceId]);

  const afterChange = (msg: string) => {
    setFlash(msg);
    onChanged();
  };

  const doArrival = async (arrived: boolean) => {
    setBusy(true);
    setActionError(null);
    console.info('[web tickets] arrival submit', { bookingId: r.bookingId, arrived });
    const res = await setTicketArrival(r.bookingId, arrived);
    setBusy(false);
    if (!res.ok) {
      console.warn('[web tickets] arrival error', { bookingId: r.bookingId, error: res.error });
      setActionError(arrivalError(res.error));
      return;
    }
    console.info('[web tickets] arrival success', { bookingId: r.bookingId, ...res.data });
    afterChange(arrived ? 'סומן שהגיע/ה.' : 'סימון ההגעה בוטל.');
  };

  const doMove = async (target: MoveTargetRound) => {
    setBusy(true);
    setActionError(null);
    console.info('[web tickets] move submit', {
      bookingId: r.bookingId,
      targetRoundInstanceId: target.roundInstanceId,
    });
    const res = await moveBooking(r.bookingId, target.roundInstanceId);
    setBusy(false);
    setMoving(false);
    if (!res.ok) {
      console.warn('[web tickets] move error', { bookingId: r.bookingId, error: res.error });
      setActionError(moveError(res.error));
      return;
    }
    console.info('[web tickets] move success', { bookingId: r.bookingId });
    afterChange(`הכרטיס הועבר ל${target.label} ${target.startTime}.`);
  };

  const doRemove = async () => {
    setBusy(true);
    setActionError(null);
    console.info('[web tickets] remove submit', { bookingId: r.bookingId, source: r.source });
    const res = await removeBooking(r.bookingId);
    setBusy(false);
    setConfirmingRemove(false);
    if (!res.ok) {
      console.warn('[web tickets] remove error', { bookingId: r.bookingId, error: res.error });
      setActionError(removeError(res.error));
      return;
    }
    const bits: string[] = [];
    if (res.data.refunded) bits.push(`הוחזרו ₪${res.data.refundAmountIls}`);
    if (res.data.punchReturned) bits.push('הכניסה הוחזרה לכרטיסייה');
    console.info('[web tickets] remove success', { bookingId: r.bookingId, ...res.data });
    afterChange(`הכרטיס הוסר${bits.length ? ' · ' + bits.join(' · ') : ''}.`);
  };

  const detailItem = (label: string, value: string) => (
    <span style={{ fontSize: 12.5, color: MUTED }}>
      {label}: <span style={{ color: INK }}>{value}</span>
    </span>
  );

  return (
    <div style={{ padding: '12px 14px', background: '#fffaf6', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
        {detailItem('נוצר', fmtDateTime(r.createdAt))}
        {r.usedAt && detailItem('נכנס/ה', fmtDateTime(r.usedAt))}
        {r.punchCardSerial && detailItem('כרטיסייה', r.punchCardSerial)}
        {r.wcOrderId && detailItem('הזמנת אתר', `#${r.wcOrderId}`)}
        {r.additionalCompanions > 0 && detailItem('מלווים נוספים', String(r.additionalCompanions))}
      </div>

      {flash && (
        <div style={{ fontSize: 13, color: '#0f7a44', background: '#eef7ee', borderRadius: 9, padding: '8px 12px' }}>
          {flash}
        </div>
      )}
      {actionError && (
        <div style={{ fontSize: 13, color: '#a23a3a', background: '#fdf0ee', borderRadius: 9, padding: '8px 12px' }}>
          {actionError}
        </div>
      )}

      {(canMove || canMarkArrival || canRemove) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {canMarkArrival && r.status === 'confirmed' && (
            <button type="button" disabled={busy} style={ghostBtn} onClick={() => void doArrival(true)}>
              סימון הגעה
            </button>
          )}
          {canMarkArrival && r.status === 'used' && (
            <button type="button" disabled={busy} style={ghostBtn} onClick={() => void doArrival(false)}>
              ביטול סימון הגעה
            </button>
          )}
          {canMove && (
            <button
              type="button"
              disabled={busy}
              style={ghostBtn}
              onClick={() => {
                setActionError(null);
                setConfirmingRemove(false);
                setMoving(!moving);
              }}
            >
              העברה לסבב אחר
            </button>
          )}
          {canRemove && (
            <button
              type="button"
              disabled={busy}
              style={dangerBtn}
              onClick={() => {
                setActionError(null);
                setMoving(false);
                setConfirmingRemove(!confirmingRemove);
              }}
            >
              הסרה
            </button>
          )}
        </div>
      )}

      {moving && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12.5, color: MUTED }}>העברה אל:</span>
          {targets === null ? (
            <span style={{ fontSize: 12.5, color: MUTED }}>טוען סבבים…</span>
          ) : targets.length === 0 ? (
            <span style={{ fontSize: 12.5, color: MUTED }}>אין סבב אחר פתוח בתאריך הזה.</span>
          ) : (
            targets.map((t) => (
              <button
                key={t.roundInstanceId}
                type="button"
                disabled={busy}
                style={ghostBtn}
                onClick={() => void doMove(t)}
              >
                {t.label} {t.startTime} ({t.taken}/{t.capacity})
              </button>
            ))
          )}
        </div>
      )}

      {confirmingRemove && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5, color: INK }}>
            להסיר את הכרטיס?{' '}
            {r.source === 'paid' && 'הכסף יוחזר אוטומטית ב-WooCommerce. '}
            {r.source === 'punchcard' && 'הכניסה תוחזר לכרטיסייה. '}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              disabled={busy}
              style={{ ...ghostBtn, background: '#c0554b', color: '#fff', border: 'none' }}
              onClick={() => void doRemove()}
            >
              {busy ? 'מסיר…' : 'כן, הסירו'}
            </button>
            <button type="button" disabled={busy} style={ghostBtn} onClick={() => setConfirmingRemove(false)}>
              ביטול
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
