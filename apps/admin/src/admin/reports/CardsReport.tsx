import { useEffect, useMemo, useState } from 'react';
import {
  fetchCardsReport,
  type CardsReportFilters,
  type CardsReportRow,
} from '../../lib/api/reports';
import { downloadCsv, presetRange, printReport, toCsv } from '../../lib/export';
import { parseDaysInput, parsePctInput } from './filter-inputs';
import {
  DateRangeField,
  EmptyState,
  ExportBar,
  Field,
  FieldRow,
  FilterBar,
  fmtDay,
  inputStyle,
  LoadingState,
  SearchInput,
  SectionShell,
  SelectField,
  sourceLabelShort,
  Table,
  Td,
  type DateRangeValue,
  type TableCol,
} from './shared';

type SortKey = 'createdAt' | 'expiresAt' | 'usedEntries' | 'serialNumber';

const SORT_KEYS = ['createdAt', 'expiresAt', 'usedEntries', 'serialNumber'] as const;
const isSortKey = (k: string): k is SortKey => (SORT_KEYS as readonly string[]).includes(k);

export function CardsReport() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'expired' | 'cancelled'>('');
  const [source, setSource] = useState<'' | 'pos' | 'online' | 'manual'>('');
  const [sold, setSold] = useState<DateRangeValue>({
    preset: 'allTime',
    range: presetRange('allTime'),
  });
  const [expiringWithinDays, setExpiringWithinDays] = useState<string>('');
  const [usageMin, setUsageMin] = useState<string>('');
  const [usageMax, setUsageMax] = useState<string>('');
  const [sort, setSort] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [rows, setRows] = useState<CardsReportRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters: CardsReportFilters = useMemo(() => {
    const f: CardsReportFilters = { sort, sortDir };
    if (q.trim()) f.q = q.trim();
    if (status) f.status = status;
    if (source) f.source = source;
    if (sold.range.from) f.soldFrom = sold.range.from.toISOString();
    if (sold.range.to) f.soldTo = sold.range.to.toISOString();
    const e = parseDaysInput(expiringWithinDays);
    if (e !== undefined) f.expiringWithinDays = e;
    const lo = parsePctInput(usageMin);
    const hi = parsePctInput(usageMax);
    if (lo !== undefined) f.usageMinPct = lo;
    if (hi !== undefined) f.usageMaxPct = hi;
    return f;
  }, [q, status, source, sold, expiringWithinDays, usageMin, usageMax, sort, sortDir]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await fetchCardsReport(filters);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setRows(res.data.rows);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const onSort = (k: string) => {
    if (!isSortKey(k)) return;
    if (sort === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(k);
      setSortDir(k === 'serialNumber' ? 'asc' : 'desc');
    }
  };

  const cols: TableCol<SortKey | 'customer' | 'usage' | 'status'>[] = [
    { key: 'serialNumber', label: 'מס׳ סידורי', sortable: true, width: 160 },
    { key: 'customer', label: 'לקוח' },
    { key: 'usedEntries', label: 'ניצול', sortable: true, width: 110 },
    { key: 'expiresAt', label: 'תוקף', sortable: true, width: 120 },
    { key: 'status', label: 'סטטוס', width: 90 },
    { key: 'createdAt', label: 'נמכרה', sortable: true, width: 110 },
  ];

  const statusLabel = (r: CardsReportRow): string => {
    if (r.cancelledAt) return 'בוטלה';
    if (!r.isActive) return 'לא פעילה';
    return 'פעילה';
  };

  const exportCsv = () => {
    if (!rows) return;
    const csv = toCsv(rows, [
      { label: 'מס׳ סידורי', value: (r) => r.serialNumber },
      { label: 'מס׳ לקוח', value: (r) => r.customerNumber ?? '' },
      {
        label: 'לקוח',
        value: (r) => `${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim(),
      },
      { label: 'טלפון', value: (r) => r.customerPhone ?? '' },
      { label: 'נוצלו', value: (r) => r.usedEntries },
      { label: 'סה״כ', value: (r) => r.totalEntries },
      { label: 'ניצול %', value: (r) => r.usagePct },
      { label: 'תוקף', value: (r) => (r.expiresAt ? fmtDay(r.expiresAt) : 'ללא תפוגה') },
      { label: 'מקור', value: (r) => sourceLabelShort(r.source) },
      { label: 'סטטוס', value: (r) => statusLabel(r) },
      { label: 'נמכרה בתאריך', value: (r) => fmtDay(r.createdAt) },
    ]);
    downloadCsv(`memesh-cards-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  return (
    <SectionShell
      title="כרטיסיות"
      description="כל הכרטיסיות עם סינון לפי סטטוס, מקור, תאריך מכירה, אחוז ניצול ופג בקרוב."
    >
      <FilterBar>
        <Field label="חיפוש (סידורי / שם / טלפון / מספר לקוח)">
          <SearchInput value={q} onChange={setQ} placeholder="הקלידו…" />
        </Field>
        <DateRangeField label="נמכרה בטווח" value={sold} onChange={setSold} />
        <FieldRow>
          <SelectField
            label="סטטוס"
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: 'הכל' },
              { value: 'active', label: 'פעילות' },
              { value: 'expired', label: 'שפגו / נוצלו' },
              { value: 'cancelled', label: 'בוטלו' },
            ]}
          />
          <SelectField
            label="מקור"
            value={source}
            onChange={setSource}
            options={[
              { value: '', label: 'הכל' },
              { value: 'pos', label: 'קופה' },
              { value: 'online', label: 'אונליין' },
              { value: 'manual', label: 'ידני (אדמין)' },
            ]}
          />
          <Field label="פג בקרוב (ימים)">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={expiringWithinDays}
              onChange={(e) => setExpiringWithinDays(e.target.value)}
              placeholder="למשל 30"
              style={inputStyle}
            />
          </Field>
          <Field label="ניצול מינ׳ %">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={usageMin}
              onChange={(e) => setUsageMin(e.target.value)}
              placeholder="0"
              style={inputStyle}
            />
          </Field>
          <Field label="ניצול מקס׳ %">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={usageMax}
              onChange={(e) => setUsageMax(e.target.value)}
              placeholder="100"
              style={inputStyle}
            />
          </Field>
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
          sortKey={sort}
          sortDir={sortDir}
          onSort={onSort}
          empty={<EmptyState>לא נמצאו כרטיסיות תואמות לסינון.</EmptyState>}
          render={(r) => (
            <tr key={r.id}>
              <Td muted>{r.serialNumber}</Td>
              <Td>
                <div>
                  {(r.customerFirstName ?? '') + ' ' + (r.customerLastName ?? '')}
                </div>
                {r.customerNumber && (
                  <div style={{ fontSize: 12, color: '#9a9a9a' }}>
                    {r.customerNumber} · {r.customerPhone ?? '—'}
                  </div>
                )}
              </Td>
              <Td muted>
                {r.usedEntries} / {r.totalEntries}{' '}
                <span style={{ color: '#9a9a9a' }}>({r.usagePct}%)</span>
              </Td>
              <Td muted>{r.expiresAt ? fmtDay(r.expiresAt) : 'ללא תפוגה'}</Td>
              <Td>{statusLabel(r)}</Td>
              <Td muted>{fmtDay(r.createdAt)}</Td>
            </tr>
          )}
        />
      )}

      {rows && rows.length > 0 && (
        <ExportBar
          resultCount={rows.length}
          onExportCsv={exportCsv}
          onPrint={() => printReport('דוח כרטיסיות')}
        />
      )}
    </SectionShell>
  );
}
