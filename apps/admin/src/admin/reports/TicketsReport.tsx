import { useEffect, useMemo, useState } from 'react';
import {
  fetchTicketsReport,
  type TicketsReportFilters,
  type TicketsReportRow,
  type TicketsReportSummary,
} from '../../lib/api/reports';
import { downloadCsv, printReport, toCsv, toDateInput, venueTodayIso } from '../../lib/export';
import {
  DateRangeField,
  EmptyState,
  ExportBar,
  FieldRow,
  FilterBar,
  fmtDateTime,
  inputStyle,
  LoadingState,
  MUTED,
  SearchInput,
  SectionShell,
  SelectField,
  StatTile,
  Table,
  Td,
  ticketSourceLabel,
  ticketStatusMeta,
  ticketTypeLabel,
  type DateRangeValue,
  type TableCol,
} from './shared';

const PAGE_SIZE = 50;

export function TicketsReport() {
  // Tickets live in the future as much as the past (upcoming bookings), so the
  // default is the whole timeline — the presets narrow when needed.
  const [when, setWhen] = useState<DateRangeValue>({
    preset: 'allTime',
    range: { from: null, to: null },
  });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'confirmed' | 'used' | 'cancelled' | 'expired'>('');
  const [source, setSource] = useState<'' | 'paid' | 'punchcard' | 'gift' | 'manual'>('');
  const [ticketType, setTicketType] = useState<'' | 'child_under_walking' | 'child_over_walking'>('');
  const [sort, setSort] = useState<'date' | 'createdAt' | 'bookingNumber'>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<TicketsReportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<TicketsReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = venueTodayIso();

  // Reset page on any filter change.
  useEffect(() => {
    setPage(0);
  }, [when, q, status, source, ticketType, sort, sortDir]);

  const filters: TicketsReportFilters = useMemo(() => {
    const f: TicketsReportFilters = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      sort,
      sortDir,
    };
    if (when.range.from) f.dateFrom = toDateInput(when.range.from);
    if (when.range.to) f.dateTo = toDateInput(when.range.to);
    if (q.trim()) f.q = q.trim().slice(0, 120);
    if (status) f.status = status;
    if (source) f.source = source;
    if (ticketType) f.ticketType = ticketType;
    return f;
  }, [when, q, status, source, ticketType, sort, sortDir, page]);

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
      } else {
        setError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const onSort = (key: 'number' | 'customer' | 'date' | 'round' | 'created' | 'type' | 'source' | 'status') => {
    const mapped = key === 'created' ? 'createdAt' : key === 'number' ? 'bookingNumber' : 'date';
    if (sort === mapped) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(mapped);
      setSortDir('desc');
    }
  };

  const cols: TableCol<'number' | 'customer' | 'date' | 'round' | 'type' | 'source' | 'status' | 'created'>[] = [
    { key: 'number', label: 'מס׳ כרטיס', width: 150, sortable: true },
    { key: 'customer', label: 'לקוח' },
    { key: 'date', label: 'תאריך סבב', width: 100, sortable: true },
    { key: 'round', label: 'סבב', width: 140 },
    { key: 'type', label: 'סוג', width: 80 },
    { key: 'source', label: 'מקור', width: 90 },
    { key: 'status', label: 'סטטוס', width: 110 },
    { key: 'created', label: 'נרכש', width: 130, sortable: true },
  ];
  const sortKey = sort === 'createdAt' ? 'created' : sort === 'bookingNumber' ? 'number' : 'date';

  const exportCsv = () => {
    if (!rows) return;
    const csv = toCsv(rows, [
      { label: 'מס׳ כרטיס', value: (r) => r.bookingNumber ?? '' },
      {
        label: 'לקוח',
        value: (r) => `${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim(),
      },
      { label: 'מס׳ לקוח', value: (r) => r.customerNumber ?? '' },
      { label: 'טלפון', value: (r) => r.customerPhone ?? '' },
      { label: 'תאריך סבב', value: (r) => r.date },
      { label: 'סבב', value: (r) => `${r.roundLabel} ${r.startTime}-${r.endTime}` },
      { label: 'סוג', value: (r) => ticketTypeLabel(r.ticketType) },
      { label: 'מלווים נוספים', value: (r) => r.additionalCompanions },
      { label: 'מקור', value: (r) => ticketSourceLabel(r.source) },
      { label: 'סטטוס', value: (r) => ticketStatusMeta(r.status, r.date, today).label },
      { label: 'כרטיסייה', value: (r) => r.punchCardSerial ?? '' },
      { label: 'הזמנת אתר', value: (r) => r.wcOrderId ?? '' },
      { label: 'נרכש', value: (r) => fmtDateTime(r.createdAt) },
      { label: 'נכנס/ה', value: (r) => (r.usedAt ? fmtDateTime(r.usedAt) : '') },
    ]);
    downloadCsv(`memesh-tickets-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <SectionShell
      title="כרטיסים"
      description="כרטיסי כניסה לסבבים — כמה נמכרו, כמה מומשו בפועל, ביטולים ומקורות הרכישה."
    >
      <FilterBar>
        <DateRangeField label="טווח תאריכי סבב" value={when} onChange={setWhen} />
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="מספר כרטיס (R-...), שם, טלפון או מספר לקוח…"
        />
        <FieldRow>
          <SelectField
            label="סטטוס"
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: 'הכל' },
              { value: 'confirmed', label: 'הזמנות פעילות' },
              { value: 'used', label: 'הגיעו' },
              { value: 'cancelled', label: 'בוטלו' },
              { value: 'expired', label: 'פגו' },
            ]}
          />
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
          <SelectField
            label="סוג כרטיס"
            value={ticketType}
            onChange={setTicketType}
            options={[
              { value: '', label: 'הכל' },
              { value: 'child_over_walking', label: 'ילד/ה' },
              { value: 'child_under_walking', label: 'תינוק' },
            ]}
          />
        </FieldRow>
      </FilterBar>

      {summary && (
        <div style={{ display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <StatTile
            label='סה"כ כרטיסים'
            value={summary.confirmed + summary.used + summary.cancelled + summary.expired}
          />
          <StatTile label="הגיעו" value={summary.used} />
          <StatTile label="הזמנות פעילות" value={summary.confirmed} />
          <StatTile label="בוטלו" value={summary.cancelled} />
          <StatTile label="מלווים נוספים" value={summary.companions} />
        </div>
      )}

      {loading && <LoadingState />}
      {error && (
        <div style={{ marginTop: 14, color: '#a23a3a', fontSize: 14 }}>שגיאה בטעינה: {error}</div>
      )}

      {rows && (
        <Table
          cols={cols}
          rows={rows}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          empty={<EmptyState>אין כרטיסים תואמים לסינון בטווח שנבחר.</EmptyState>}
          render={(r) => {
            const meta = ticketStatusMeta(r.status, r.date, today);
            return (
              <tr key={r.bookingId} style={{ opacity: r.status === 'cancelled' ? 0.55 : 1 }}>
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
                <Td muted>
                  {ticketSourceLabel(r.source)}
                  {r.punchCardSerial && (
                    <div style={{ fontSize: 12, color: '#9a9a9a' }}>{r.punchCardSerial}</div>
                  )}
                </Td>
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
                <Td muted>{fmtDateTime(r.createdAt)}</Td>
              </tr>
            );
          }}
        />
      )}

      {rows && total > 0 && (
        <>
          <ExportBar
            resultCount={total}
            onExportCsv={exportCsv}
            onPrint={() => printReport('דוח כרטיסים')}
          />
          <div
            className="no-print"
            style={{
              marginTop: 12,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 12,
              fontSize: 13,
              color: MUTED,
            }}
          >
            <button
              type="button"
              style={{
                ...inputStyle,
                width: 'auto',
                cursor: page === 0 ? 'not-allowed' : 'pointer',
                opacity: page === 0 ? 0.5 : 1,
              }}
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              ← הקודם
            </button>
            <span>
              עמוד {page + 1} מתוך {totalPages}
            </span>
            <button
              type="button"
              style={{
                ...inputStyle,
                width: 'auto',
                cursor: page + 1 >= totalPages ? 'not-allowed' : 'pointer',
                opacity: page + 1 >= totalPages ? 0.5 : 1,
              }}
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              הבא →
            </button>
          </div>
        </>
      )}
    </SectionShell>
  );
}
