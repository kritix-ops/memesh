import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import {
  fromDateInput,
  PRESET_LABELS,
  presetRange,
  toDateInput,
  type DatePresetId,
  type DateRange,
} from '../../lib/export';

export const ORANGE = '#ffa983';
export const INK = '#2d3436';
export const MUTED = '#636e72';
export const SHADOW = '0 4px 20px rgba(0,0,0,0.08)';

export const card: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 20,
};

export const inputStyle: CSSProperties = {
  fontSize: 14,
  padding: '9px 12px',
  border: '1.5px solid #e9e0d9',
  borderRadius: 10,
  background: '#fff',
  outline: 'none',
  boxSizing: 'border-box',
  width: '100%',
};

const chipBase: CSSProperties = {
  border: '1.5px solid #e9e0d9',
  background: '#fff',
  color: MUTED,
  borderRadius: 999,
  padding: '6px 14px',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const chipActive: CSSProperties = {
  ...chipBase,
  background: '#fff4ee',
  borderColor: ORANGE,
  color: '#c97a52',
};

const ghostBtn: CSSProperties = {
  background: '#fff',
  color: MUTED,
  border: '1.5px solid #e9e0d9',
  borderRadius: 10,
  fontWeight: 600,
  padding: '8px 16px',
  fontSize: 13.5,
  cursor: 'pointer',
};
const primaryBtn: CSSProperties = {
  background: ORANGE,
  color: '#fff',
  border: 'none',
  borderRadius: 10,
  fontWeight: 600,
  padding: '8px 16px',
  fontSize: 13.5,
  cursor: 'pointer',
};

export function SectionShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={card}
      className="report-printable"
      data-print-date={new Date().toLocaleDateString('he-IL', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>{title}</div>
      {description && (
        <div className="no-print" style={{ color: MUTED, fontSize: 13.5, marginTop: 4 }}>
          {description}
        </div>
      )}
      {children}
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div
      className="report-filters"
      style={{
        marginTop: 14,
        padding: 14,
        background: '#fff8f3',
        border: '1px solid #ffe3d4',
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140, flex: 1 }}>
      <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{children}</div>
  );
}

export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} style={active ? chipActive : chipBase}>
      {children}
    </button>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{children}</div>;
}

// Debounced text input — used for the report q / search fields.
export function SearchInput({
  value,
  onChange,
  placeholder,
  debounceMs = 300,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  debounceMs?: number;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (local !== value) onChange(local);
    }, debounceMs);
    return () => clearTimeout(t);
  }, [local, value, onChange, debounceMs]);
  return (
    <input
      style={inputStyle}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      {...(placeholder !== undefined && { placeholder })}
      type="search"
    />
  );
}

const PRESET_ORDER: DatePresetId[] = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'lastYear',
  'allTime',
];

export interface DateRangeValue {
  preset: DatePresetId;
  range: DateRange;
}

/**
 * Compact date-range picker. Top row: quick-preset chips. Bottom row: from/to
 * date inputs that activate the "custom" preset when edited. Returns a
 * `DateRangeValue` so callers can persist the chosen preset and not just the
 * resolved dates (useful for the URL state / re-render bookkeeping).
 */
export function DateRangeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
}) {
  const pick = (preset: DatePresetId) => {
    if (preset === 'custom') {
      onChange({ preset, range: value.range });
      return;
    }
    onChange({ preset, range: presetRange(preset) });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 240, flex: 2 }}>
      <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{label}</span>
      <ChipRow>
        {PRESET_ORDER.map((p) => (
          <Chip key={p} active={value.preset === p} onClick={() => pick(p)}>
            {PRESET_LABELS[p]}
          </Chip>
        ))}
      </ChipRow>
      {value.preset === 'custom' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            type="date"
            value={toDateInput(value.range.from)}
            onChange={(e) =>
              onChange({
                preset: 'custom',
                range: { ...value.range, from: fromDateInput(e.target.value) },
              })
            }
            style={inputStyle}
          />
          <input
            type="date"
            value={toDateInput(value.range.to)}
            onChange={(e) =>
              onChange({
                preset: 'custom',
                range: { ...value.range, to: fromDateInput(e.target.value) },
              })
            }
            style={inputStyle}
          />
        </div>
      )}
    </div>
  );
}

// Generic select with a "lo / hi" tri-state for boolean filters.
export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T | '';
  onChange: (next: T | '') => void;
  options: ReadonlyArray<{ value: T | ''; label: string }>;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T | '')}
        style={{ ...inputStyle, paddingInlineEnd: 32 }}
      >
        {options.map((o) => (
          <option key={o.value || 'all'} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

// Sticky-headered, sortable table. `cols` defines headers + sort keys; `rows`
// is rendered by `render`. Sort state is managed by the caller — the table
// just emits onSort with the key clicked.
export interface TableCol<K extends string> {
  key: K;
  label: string;
  sortable?: boolean;
  width?: number | string;
  align?: 'right' | 'left' | 'center';
}

export function Table<K extends string, T>({
  cols,
  rows,
  sortKey,
  sortDir,
  onSort,
  render,
  empty,
}: {
  cols: TableCol<K>[];
  rows: T[];
  sortKey?: K;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: K) => void;
  render: (row: T, i: number) => ReactNode;
  empty?: ReactNode;
}) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;
  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginTop: 14 }}>
      <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: 13.5 }}>
        <thead>
          <tr>
            {cols.map((c) => {
              const isSorted = sortKey === c.key;
              const arrow = !isSorted ? '' : sortDir === 'asc' ? ' ↑' : ' ↓';
              return (
                <th
                  key={c.key}
                  style={{
                    textAlign: c.align ?? 'right',
                    color: MUTED,
                    fontWeight: 600,
                    fontSize: 12.5,
                    padding: '8px 6px',
                    borderBottom: '1.5px solid #f3efea',
                    cursor: c.sortable && onSort ? 'pointer' : 'default',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                    ...(c.width !== undefined && { width: c.width }),
                  }}
                  onClick={() => c.sortable && onSort && onSort(c.key)}
                >
                  {c.label}
                  {arrow}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{rows.map((r, i) => render(r, i))}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  align,
  muted,
}: {
  children: ReactNode;
  align?: 'right' | 'left' | 'center';
  muted?: boolean;
}) {
  return (
    <td
      style={{
        padding: '9px 6px',
        textAlign: align ?? 'right',
        color: muted ? MUTED : INK,
        borderBottom: '1px solid #f3efea',
        verticalAlign: 'top',
      }}
    >
      {children}
    </td>
  );
}

export function ExportBar({
  onExportCsv,
  onPrint,
  resultCount,
}: {
  onExportCsv: () => void;
  onPrint: () => void;
  resultCount: number;
}) {
  return (
    <div
      className="report-actions"
      style={{
        marginTop: 14,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ fontSize: 13, color: MUTED }}>
        סה"כ <strong style={{ color: INK }}>{resultCount}</strong> תוצאות
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={ghostBtn} onClick={onExportCsv}>
          ייצוא CSV
        </button>
        <button type="button" style={primaryBtn} onClick={onPrint}>
          הדפסה / PDF
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 18,
        padding: 22,
        textAlign: 'center',
        color: MUTED,
        background: '#fafafa',
        border: '1px dashed #ececec',
        borderRadius: 12,
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

export function LoadingState() {
  return (
    <div style={{ marginTop: 18, padding: 22, textAlign: 'center', color: MUTED, fontSize: 14 }}>
      טוען…
    </div>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div
      style={{
        ...card,
        flex: 1,
        minWidth: 160,
        padding: '14px 18px',
      }}
    >
      <div style={{ color: MUTED, fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, color: INK, marginTop: 4 }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

// Format helpers shared across reports.
export const fmtDay = (iso: string | null): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('he-IL', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  });
};
export const fmtDateTime = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${fmtDay(iso)} · ${hh}:${mm}`;
};
export const sourceLabelShort = (s: string | null): string => {
  if (s === 'referral') return 'חבר/ה';
  if (s === 'social') return 'רשתות';
  if (s === 'walk_by') return 'עבר ברחוב';
  if (s === 'website') return 'אתר';
  if (s === 'other') return 'אחר';
  if (s === 'pos') return 'קופה';
  if (s === 'online') return 'אונליין';
  if (s === 'manual') return 'ידני';
  return '—';
};
export const methodLabel = (m: string): string => {
  if (m === 'qr_scan') return 'סריקת QR';
  if (m === 'serial') return 'מספר סידורי';
  if (m === 'phone') return 'טלפון';
  if (m === 'manual') return 'ידני';
  return m;
};
