import { useEffect, useMemo, useState } from 'react';
import {
  fetchCancellationsReport,
  type CancellationKind,
  type CancellationsReportFilters,
  type CancellationsReportRow,
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

const kindLabel = (k: CancellationKind): string =>
  k === 'card' ? 'ביטול כרטיסייה' : 'החזר כניסה';

export function CancellationsReport() {
  const [when, setWhen] = useState<DateRangeValue>({
    preset: 'last30',
    range: presetRange('last30'),
  });
  const [kind, setKind] = useState<'' | CancellationKind>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<CancellationsReportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cardCount, setCardCount] = useState(0);
  const [entryCount, setEntryCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset page on any filter change.
  useEffect(() => {
    setPage(0);
  }, [when, kind, q]);

  const filters: CancellationsReportFilters = useMemo(() => {
    const f: CancellationsReportFilters = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (when.range.from) f.from = when.range.from.toISOString();
    if (when.range.to) f.to = when.range.to.toISOString();
    if (kind) f.kind = kind;
    if (q.trim()) f.q = q.trim();
    return f;
  }, [when, kind, q, page]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    console.info('[web admin reports] cancellations fetch', { filters });
    (async () => {
      const res = await fetchCancellationsReport(filters);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        console.info('[web admin reports] cancellations fetch ok', {
          rows: res.data.rows.length,
          total: res.data.total,
        });
        setRows(res.data.rows);
        setTotal(res.data.total);
        setCardCount(res.data.cardCount);
        setEntryCount(res.data.entryCount);
      } else {
        console.warn('[web admin reports] cancellations fetch failed', { error: res.error });
        setError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const cols: TableCol<'when' | 'kind' | 'customer' | 'card' | 'detail' | 'reason' | 'actor'>[] = [
    { key: 'when', label: 'תאריך + שעה', width: 140 },
    { key: 'kind', label: 'סוג', width: 120 },
    { key: 'customer', label: 'לקוח' },
    { key: 'card', label: 'כרטיסייה', width: 150 },
    { key: 'detail', label: 'פרטים', width: 130 },
    { key: 'reason', label: 'סיבה' },
    { key: 'actor', label: 'בוצע ע״י', width: 140 },
  ];

  const detailFor = (r: CancellationsReportRow): string => {
    if (r.kind === 'card') {
      const used = r.usedEntries ?? 0;
      const total = r.totalEntries ?? 0;
      return `ניצול ${used}/${total}`;
    }
    const n = r.entriesConsumed ?? 1;
    return `${n} כניסות · ${methodLabel(r.method ?? '')}`;
  };

  const exportCsv = () => {
    if (!rows) return;
    const csv = toCsv(rows, [
      { label: 'תאריך + שעה', value: (r) => fmtDateTime(r.occurredAt) },
      { label: 'סוג', value: (r) => kindLabel(r.kind) },
      {
        label: 'לקוח',
        value: (r) => `${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim(),
      },
      { label: 'מס׳ לקוח', value: (r) => r.customerNumber ?? '' },
      { label: 'מס׳ כרטיסייה', value: (r) => r.cardSerial },
      {
        label: 'פרטים',
        value: (r) => detailFor(r),
      },
      { label: 'סיבה', value: (r) => r.reason ?? '' },
      {
        label: 'בוצע ע״י',
        value: (r) => `${r.actorFirstName ?? ''} ${r.actorLastName ?? ''}`.trim(),
      },
      {
        label: 'מועד כניסה מקורית',
        value: (r) => (r.originalPunchedAt ? fmtDateTime(r.originalPunchedAt) : ''),
      },
    ]);
    downloadCsv(`memesh-cancellations-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <SectionShell
      title="ביטולים"
      description="ביטולי כרטיסיות והחזרי כניסות, בתצוגה אחת לפי טווח תאריכים, סוג ולקוח / כרטיסייה."
    >
      <FilterBar>
        <DateRangeField label="טווח ביטולים" value={when} onChange={setWhen} />
        <FieldRow>
          <SelectField
            label="סוג"
            value={kind}
            onChange={setKind}
            options={[
              { value: '', label: 'הכל' },
              { value: 'card', label: 'ביטולי כרטיסיות' },
              { value: 'entry', label: 'החזרי כניסות' },
            ]}
          />
          <Field label="חיפוש (סידורי / שם / טלפון / מספר לקוח)">
            <SearchInput value={q} onChange={setQ} placeholder="הקלידו…" />
          </Field>
        </FieldRow>
      </FilterBar>

      {rows && (
        <div
          className="no-print"
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 14,
            fontSize: 13,
            color: MUTED,
          }}
        >
          <span>
            ביטולי כרטיסיות: <strong>{cardCount}</strong>
          </span>
          <span>
            החזרי כניסות: <strong>{entryCount}</strong>
          </span>
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
          empty={<EmptyState>אין ביטולים תואמים לסינון בטווח שנבחר.</EmptyState>}
          render={(r) => (
            <tr key={`${r.kind}:${r.id}`}>
              <Td muted>{fmtDateTime(r.occurredAt)}</Td>
              <Td>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: r.kind === 'card' ? '#fde2e2' : '#fff0d6',
                    color: r.kind === 'card' ? '#a23a3a' : '#8a5a00',
                  }}
                >
                  {kindLabel(r.kind)}
                </span>
              </Td>
              <Td>
                {(r.customerFirstName ?? '') + ' ' + (r.customerLastName ?? '')}
                {r.customerNumber && (
                  <div style={{ fontSize: 12, color: '#9a9a9a' }}>{r.customerNumber}</div>
                )}
              </Td>
              <Td muted>{r.cardSerial}</Td>
              <Td muted>
                {detailFor(r)}
                {r.kind === 'entry' && r.originalPunchedAt && (
                  <div style={{ fontSize: 12, color: '#9a9a9a' }}>
                    כניסה מ-{fmtDateTime(r.originalPunchedAt)}
                  </div>
                )}
              </Td>
              <Td>{r.reason ?? <span style={{ color: MUTED }}>—</span>}</Td>
              <Td muted>
                {r.actorFirstName || r.actorLastName
                  ? `${r.actorFirstName ?? ''} ${r.actorLastName ?? ''}`.trim()
                  : '—'}
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
            onPrint={() => printReport('דוח ביטולים')}
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
