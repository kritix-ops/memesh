import { useEffect, useMemo, useState } from 'react';
import {
  fetchRevenueReport,
  type RevenueReportFilters,
  type RevenueReportResult,
} from '../../lib/api/reports';
import { downloadCsv, presetRange, printReport, toCsv } from '../../lib/export';
import {
  DateRangeField,
  EmptyState,
  ExportBar,
  FieldRow,
  FilterBar,
  LoadingState,
  MUTED,
  SectionShell,
  SelectField,
  StatTile,
  Table,
  Td,
  type DateRangeValue,
  type TableCol,
} from './shared';

const fmtMoney = (n: number): string => `₪${n.toLocaleString('he-IL')}`;

export function RevenueReport() {
  const [when, setWhen] = useState<DateRangeValue>({
    preset: 'thisMonth',
    range: presetRange('thisMonth'),
  });
  const [groupBy, setGroupBy] = useState<'day' | 'week' | 'month'>('day');
  const [result, setResult] = useState<RevenueReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters: RevenueReportFilters = useMemo(() => {
    const f: RevenueReportFilters = { groupBy };
    if (when.range.from) f.from = when.range.from.toISOString();
    if (when.range.to) f.to = when.range.to.toISOString();
    return f;
  }, [when, groupBy]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await fetchRevenueReport(filters);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setResult(res.data);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const cols: TableCol<'period' | 'cards' | 'revenue'>[] = [
    { key: 'period', label: 'תקופה', width: 160 },
    { key: 'cards', label: 'כרטיסיות שנמכרו', width: 160 },
    { key: 'revenue', label: 'הכנסה משוערת' },
  ];

  const exportCsv = () => {
    if (!result) return;
    const csv = toCsv(result.rows, [
      { label: 'תקופה', value: (r) => r.period },
      { label: 'כרטיסיות שנמכרו', value: (r) => r.cardsSold },
      { label: 'הכנסה משוערת (₪)', value: (r) => r.estimatedRevenueShekels },
    ]);
    downloadCsv(`memesh-revenue-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  return (
    <SectionShell
      title="הכנסות"
      description="סיכום כרטיסיות שנמכרו לפי תקופה. הכנסה משוערת = מחיר נוכחי בהגדרות × כמות. כרטיסיות שבוטלו לא נחשבות."
    >
      <FilterBar>
        <DateRangeField label="טווח" value={when} onChange={setWhen} />
        <FieldRow>
          <SelectField
            label="קיבוץ לפי"
            value={groupBy}
            onChange={(v) => v && setGroupBy(v)}
            options={[
              { value: 'day', label: 'יום' },
              { value: 'week', label: 'שבוע' },
              { value: 'month', label: 'חודש' },
            ]}
          />
        </FieldRow>
      </FilterBar>

      {loading && <LoadingState />}
      {error && (
        <div style={{ marginTop: 14, color: '#a23a3a', fontSize: 14 }}>שגיאה בטעינה: {error}</div>
      )}

      {result && (
        <>
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <StatTile label="סה״כ כרטיסיות בטווח" value={result.totalCardsSold} />
            <StatTile
              label="סה״כ הכנסה משוערת"
              value={fmtMoney(result.totalEstimatedRevenueShekels)}
              hint={`מחיר חישובי: ${fmtMoney(result.estimatedFromPriceShekels)} לכרטיסייה`}
            />
          </div>

          <div
            className="no-print"
            style={{
              marginTop: 12,
              padding: '10px 14px',
              background: '#fff8f3',
              border: '1px solid #ffe3d4',
              borderRadius: 10,
              fontSize: 12.5,
              color: '#a8643d',
              lineHeight: 1.5,
            }}
          >
            <strong>הערה לגבי דיוק:</strong> מחיר הכרטיסייה בעת המכירה אינו נשמר היום, לכן ההכנסה
            מחושבת לפי המחיר הנוכחי בהגדרות. אם המחיר ישתנה בעתיד, כרטיסיות ישנות יחושבו לפי המחיר
            החדש (לא לפי המחיר המקורי שלהן). שמירת מחיר-בעת-מכירה היא שיפור עתידי.
          </div>

          <Table
            cols={cols}
            rows={result.rows}
            empty={<EmptyState>לא נמצאו מכירות בטווח שנבחר.</EmptyState>}
            render={(r) => (
              <tr key={r.period}>
                <Td>{r.period}</Td>
                <Td muted>{r.cardsSold}</Td>
                <Td>
                  <strong>{fmtMoney(r.estimatedRevenueShekels)}</strong>
                  <span style={{ color: MUTED, fontSize: 12.5, marginInlineStart: 6 }}>
                    משוער
                  </span>
                </Td>
              </tr>
            )}
          />
        </>
      )}

      {result && result.rows.length > 0 && (
        <ExportBar
          resultCount={result.rows.length}
          onExportCsv={exportCsv}
          onPrint={() => printReport('דוח הכנסות')}
        />
      )}
    </SectionShell>
  );
}
