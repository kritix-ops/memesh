import { useEffect, useMemo, useState } from 'react';
import {
  fetchEntriesReport,
  type EntriesReportFilters,
  type EntriesReportRow,
} from '../../lib/api/reports';
import { downloadCsv, presetRange, printReport, toCsv } from '../../lib/export';
import {
  DateRangeField,
  EmptyState,
  ExportBar,
  Field,
  FieldRow,
  FilterBar,
  fmtDateTime,
  inputStyle,
  LoadingState,
  methodLabel,
  MUTED,
  SearchInput,
  SectionShell,
  SelectField,
  Table,
  Td,
  type DateRangeValue,
  type TableCol,
} from './shared';

const PAGE_SIZE = 50;

export function EntriesReport() {
  const [when, setWhen] = useState<DateRangeValue>({
    preset: 'last30',
    range: presetRange('last30'),
  });
  const [cardSerial, setCardSerial] = useState('');
  const [method, setMethod] = useState<'' | 'qr_scan' | 'serial' | 'phone' | 'manual'>('');
  const [refunded, setRefunded] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<EntriesReportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset page on any filter change.
  useEffect(() => {
    setPage(0);
  }, [when, cardSerial, method, refunded]);

  const filters: EntriesReportFilters = useMemo(() => {
    const f: EntriesReportFilters = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (when.range.from) f.from = when.range.from.toISOString();
    if (when.range.to) f.to = when.range.to.toISOString();
    if (cardSerial.trim()) f.cardSerial = cardSerial.trim();
    if (method) f.method = method;
    if (refunded) f.refunded = refunded === 'true';
    return f;
  }, [when, cardSerial, method, refunded, page]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await fetchEntriesReport(filters);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setRows(res.data.rows);
        setTotal(res.data.total);
      } else {
        setError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const cols: TableCol<'when' | 'customer' | 'card' | 'companions' | 'method' | 'staff' | 'refunded'>[] = [
    { key: 'when', label: 'תאריך + שעה', width: 140 },
    { key: 'customer', label: 'לקוח' },
    { key: 'card', label: 'כרטיסייה', width: 150 },
    { key: 'companions', label: 'מלווים', width: 80 },
    { key: 'method', label: 'שיטה', width: 110 },
    { key: 'staff', label: 'קופאי' },
    { key: 'refunded', label: 'החזר', width: 100 },
  ];

  const exportCsv = () => {
    if (!rows) return;
    const csv = toCsv(rows, [
      { label: 'תאריך + שעה', value: (r) => fmtDateTime(r.punchedAt) },
      {
        label: 'לקוח',
        value: (r) => `${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim(),
      },
      { label: 'מס׳ לקוח', value: (r) => r.customerNumber ?? '' },
      { label: 'מס׳ כרטיסייה', value: (r) => r.cardSerial },
      { label: 'מלווים', value: (r) => r.companionCount },
      { label: 'שיטה', value: (r) => methodLabel(r.method) },
      {
        label: 'קופאי',
        value: (r) => `${r.staffFirstName ?? ''} ${r.staffLastName ?? ''}`.trim(),
      },
      { label: 'הוחזר', value: (r) => (r.refundedAt ? 'כן' : 'לא') },
      { label: 'תאריך החזר', value: (r) => (r.refundedAt ? fmtDateTime(r.refundedAt) : '') },
      { label: 'סיבת החזר', value: (r) => r.refundReason ?? '' },
    ]);
    downloadCsv(`memesh-entries-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <SectionShell
      title="כניסות"
      description="כל הכניסות שנקלטו, עם סינון לפי טווח תאריכים, כרטיסייה, שיטת קליטה ומצב החזר."
    >
      <FilterBar>
        <DateRangeField label="טווח כניסות" value={when} onChange={setWhen} />
        <FieldRow>
          <Field label="מס׳ כרטיסייה (סידורי)">
            <SearchInput
              value={cardSerial}
              onChange={setCardSerial}
              placeholder="M-YYYYMMDD-NNNN"
            />
          </Field>
          <SelectField
            label="שיטה"
            value={method}
            onChange={setMethod}
            options={[
              { value: '', label: 'הכל' },
              { value: 'qr_scan', label: 'סריקת QR' },
              { value: 'serial', label: 'מספר סידורי' },
              { value: 'phone', label: 'טלפון' },
              { value: 'manual', label: 'ידני' },
            ]}
          />
          <SelectField
            label="החזר"
            value={refunded}
            onChange={setRefunded}
            options={[
              { value: '', label: 'הכל' },
              { value: 'false', label: 'רק לא הוחזרו' },
              { value: 'true', label: 'רק שהוחזרו' },
            ]}
          />
        </FieldRow>
      </FilterBar>

      {loading && <LoadingState />}
      {error && (
        <div style={{ marginTop: 14, color: '#a23a3a', fontSize: 14 }}>שגיאה בטעינה: {error}</div>
      )}

      {rows && (
        <Table
          cols={cols}
          rows={rows}
          empty={<EmptyState>אין כניסות תואמות לסינון בטווח שנבחר.</EmptyState>}
          render={(r) => (
            <tr key={r.id} style={{ opacity: r.refundedAt ? 0.55 : 1 }}>
              <Td muted>{fmtDateTime(r.punchedAt)}</Td>
              <Td>
                {(r.customerFirstName ?? '') + ' ' + (r.customerLastName ?? '')}
                {r.customerNumber && (
                  <div style={{ fontSize: 12, color: '#9a9a9a' }}>{r.customerNumber}</div>
                )}
              </Td>
              <Td muted>{r.cardSerial}</Td>
              <Td muted>{r.companionCount}</Td>
              <Td muted>{methodLabel(r.method)}</Td>
              <Td muted>
                {r.staffFirstName || r.staffLastName
                  ? `${r.staffFirstName ?? ''} ${r.staffLastName ?? ''}`.trim()
                  : '—'}
              </Td>
              <Td>
                {r.refundedAt ? (
                  <span style={{ color: '#a23a3a', fontWeight: 600 }}>הוחזר</span>
                ) : (
                  <span style={{ color: MUTED }}>—</span>
                )}
                {r.refundReason && (
                  <div style={{ fontSize: 12, color: '#a23a3a' }}>{r.refundReason}</div>
                )}
              </Td>
            </tr>
          )}
        />
      )}

      {rows && total > 0 && (
        <>
          <ExportBar
            resultCount={total}
            onExportCsv={exportCsv}
            onPrint={() => printReport('דוח כניסות')}
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
