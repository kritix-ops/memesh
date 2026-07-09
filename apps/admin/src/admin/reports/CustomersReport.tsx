import { useEffect, useMemo, useState } from 'react';
import {
  fetchCustomersReport,
  type CustomersReportFilters,
  type CustomersReportRow,
} from '../../lib/api/reports';
import { downloadCsv, presetRange, printReport, toCsv } from '../../lib/export';
import { parseDaysInput } from './filter-inputs';
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

type SortKey = 'customerNumber' | 'createdAt' | 'lastVisit';

const SORT_KEYS = ['customerNumber', 'createdAt', 'lastVisit'] as const;
const isSortKey = (k: string): k is SortKey => (SORT_KEYS as readonly string[]).includes(k);

export function CustomersReport() {
  const [q, setQ] = useState('');
  const [registered, setRegistered] = useState<DateRangeValue>({
    preset: 'allTime',
    range: presetRange('allTime'),
  });
  const [source, setSource] = useState<'' | 'referral' | 'social' | 'walk_by' | 'website' | 'other'>('');
  const [marketing, setMarketing] = useState<'' | 'true' | 'false'>('');
  const [hasActive, setHasActive] = useState<'' | 'true' | 'false'>('');
  const [dormantDays, setDormantDays] = useState<string>('');
  const [sort, setSort] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [rows, setRows] = useState<CustomersReportRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters: CustomersReportFilters = useMemo(() => {
    const f: CustomersReportFilters = { sort, sortDir };
    if (q.trim()) f.q = q.trim();
    if (registered.range.from) f.registeredFrom = registered.range.from.toISOString();
    if (registered.range.to) f.registeredTo = registered.range.to.toISOString();
    if (source) f.source = source;
    if (marketing) f.marketingConsent = marketing === 'true';
    if (hasActive) f.hasActiveCard = hasActive === 'true';
    const dd = parseDaysInput(dormantDays);
    if (dd !== undefined) f.dormantSinceDays = dd;
    return f;
  }, [q, registered, source, marketing, hasActive, dormantDays, sort, sortDir]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await fetchCustomersReport(filters);
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
      setSortDir(k === 'customerNumber' ? 'asc' : 'desc');
    }
  };

  const cols: TableCol<SortKey | 'firstName' | 'phone' | 'lastVisit' | 'cards'>[] = [
    { key: 'customerNumber', label: 'מס׳ לקוח', sortable: true, width: 90 },
    { key: 'firstName', label: 'שם' },
    { key: 'phone', label: 'טלפון', width: 120 },
    { key: 'createdAt', label: 'נרשם', sortable: true, width: 110 },
    { key: 'lastVisit', label: 'ביקור אחרון', sortable: true, width: 130 },
    { key: 'cards', label: 'כרטיסיות', width: 110 },
  ];

  const exportCsv = () => {
    if (!rows) return;
    const csv = toCsv(rows, [
      { label: 'מספר לקוח', value: (r) => r.customerNumber },
      { label: 'שם פרטי', value: (r) => r.firstName },
      { label: 'שם משפחה', value: (r) => r.lastName },
      { label: 'טלפון', value: (r) => r.phone },
      { label: 'מייל', value: (r) => r.email ?? '' },
      { label: 'מקור', value: (r) => sourceLabelShort(r.source) },
      {
        label: 'הסכמה שיווקית',
        value: (r) => (r.marketingConsentAt ? 'כן' : 'לא'),
      },
      { label: 'נרשם בתאריך', value: (r) => fmtDay(r.createdAt) },
      { label: 'ביקור אחרון', value: (r) => (r.lastVisit ? fmtDay(r.lastVisit) : '—') },
      { label: 'כרטיסיות פעילות', value: (r) => r.activeCards },
      { label: 'סה״כ כרטיסיות', value: (r) => r.totalCards },
    ]);
    downloadCsv(`memesh-customers-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  return (
    <SectionShell
      title="לקוחות"
      description="כל הלקוחות, עם סינון לפי תאריך הרשמה, מקור, הסכמה שיווקית ומצב כרטיסייה."
    >
      <FilterBar>
        <Field label="חיפוש (שם / טלפון / מספר / מייל)">
          <SearchInput value={q} onChange={setQ} placeholder="הקלידו כדי לחפש…" />
        </Field>
        <DateRangeField label="נרשם בטווח" value={registered} onChange={setRegistered} />
        <FieldRow>
          <SelectField
            label="מקור"
            value={source}
            onChange={setSource}
            options={[
              { value: '', label: 'כל המקורות' },
              { value: 'referral', label: 'חבר/ה' },
              { value: 'social', label: 'רשתות' },
              { value: 'walk_by', label: 'עבר ברחוב' },
              { value: 'website', label: 'אתר' },
              { value: 'other', label: 'אחר' },
            ]}
          />
          <SelectField
            label="הסכמה שיווקית"
            value={marketing}
            onChange={setMarketing}
            options={[
              { value: '', label: 'הכל' },
              { value: 'true', label: 'נתנו הסכמה' },
              { value: 'false', label: 'לא נתנו' },
            ]}
          />
          <SelectField
            label="יש כרטיסייה פעילה"
            value={hasActive}
            onChange={setHasActive}
            options={[
              { value: '', label: 'הכל' },
              { value: 'true', label: 'יש פעילה' },
              { value: 'false', label: 'אין פעילה' },
            ]}
          />
          <Field label="רדומים זמן רב (ימים)">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={dormantDays}
              onChange={(e) => setDormantDays(e.target.value)}
              placeholder="למשל 60"
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
          empty={<EmptyState>לא נמצאו לקוחות תואמים לסינון.</EmptyState>}
          render={(r) => (
            <tr key={r.id}>
              <Td muted>{r.customerNumber}</Td>
              <Td>
                <div>
                  {r.firstName} {r.lastName}
                </div>
                {r.email && (
                  <div style={{ fontSize: 12, color: '#9a9a9a' }}>{r.email}</div>
                )}
              </Td>
              <Td muted>{r.phone}</Td>
              <Td muted>{fmtDay(r.createdAt)}</Td>
              <Td muted>{r.lastVisit ? fmtDay(r.lastVisit) : '—'}</Td>
              <Td>
                {r.activeCards} פעילות · {r.totalCards} סה״כ
              </Td>
            </tr>
          )}
        />
      )}

      {rows && rows.length > 0 && (
        <ExportBar
          resultCount={rows.length}
          onExportCsv={exportCsv}
          onPrint={() => printReport('דוח לקוחות')}
        />
      )}
    </SectionShell>
  );
}
