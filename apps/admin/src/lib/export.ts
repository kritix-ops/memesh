// CSV + print export helpers shared by every report screen.
// CSV runs entirely client-side over already-fetched data (zero backend cost).
// Print triggers the browser's print dialog with the page's print stylesheet
// applied — the user picks "Save as PDF" from the dialog.

// RFC 4180 escape: wrap a cell in double-quotes if it contains a comma,
// newline, or quote; double up any internal quotes.
const escapeCell = (val: unknown): string => {
  if (val === null || val === undefined) return '';
  const s = typeof val === 'string' ? val : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

export interface CsvColumn<T> {
  label: string;
  /** Cell value. Strings/numbers/booleans pass through as-is. */
  value: (row: T) => unknown;
}

/** Build a CSV string from rows + column definitions. */
export const toCsv = <T,>(rows: T[], columns: CsvColumn<T>[]): string => {
  const head = columns.map((c) => escapeCell(c.label)).join(',');
  const body = rows
    .map((r) => columns.map((c) => escapeCell(c.value(r))).join(','))
    .join('\r\n');
  // Prepend a BOM so Excel opens the file in UTF-8 and Hebrew renders correctly.
  return `﻿${head}\r\n${body}`;
};

/** Trigger a download for a CSV string. */
export const downloadCsv = (filename: string, csv: string): void => {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * Trigger the browser's print dialog. The print stylesheet in index.css
 * controls which DOM is visible. Sets a temporary <html data-print-title>
 * attribute so the printed header can echo the report name.
 */
export const printReport = (title: string): void => {
  const prev = document.documentElement.getAttribute('data-print-title');
  document.documentElement.setAttribute('data-print-title', title);
  try {
    window.print();
  } finally {
    if (prev === null) document.documentElement.removeAttribute('data-print-title');
    else document.documentElement.setAttribute('data-print-title', prev);
  }
};

// ---------------------------------------------------------------------------
// Date-range presets — used by the DateRangeField in every report's filter bar.
// All ranges return [from, to] inclusive in Asia/Jerusalem-day boundaries.
// ---------------------------------------------------------------------------

export type DatePresetId =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
  | 'lastYear'
  | 'allTime'
  | 'custom';

const startOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

export interface DateRange {
  from: Date | null;
  to: Date | null;
}

export const presetRange = (preset: DatePresetId, now: Date = new Date()): DateRange => {
  if (preset === 'today') return { from: startOfDay(now), to: endOfDay(now) };
  if (preset === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: endOfDay(y) };
  }
  if (preset === 'last7') {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { from: startOfDay(from), to: endOfDay(now) };
  }
  if (preset === 'last30') {
    const from = new Date(now);
    from.setDate(from.getDate() - 29);
    return { from: startOfDay(from), to: endOfDay(now) };
  }
  if (preset === 'thisMonth') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: startOfDay(from), to: endOfDay(now) };
  }
  if (preset === 'lastMonth') {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: startOfDay(from), to: endOfDay(to) };
  }
  if (preset === 'thisYear') {
    const from = new Date(now.getFullYear(), 0, 1);
    return { from: startOfDay(from), to: endOfDay(now) };
  }
  if (preset === 'lastYear') {
    const from = new Date(now.getFullYear() - 1, 0, 1);
    const to = new Date(now.getFullYear() - 1, 11, 31);
    return { from: startOfDay(from), to: endOfDay(to) };
  }
  return { from: null, to: null };
};

export const PRESET_LABELS: Record<DatePresetId, string> = {
  today: 'היום',
  yesterday: 'אתמול',
  last7: '7 ימים אחרונים',
  last30: '30 ימים אחרונים',
  thisMonth: 'חודש זה',
  lastMonth: 'חודש שעבר',
  thisYear: 'שנה זו',
  lastYear: 'שנה שעברה',
  allTime: 'כל הזמנים',
  custom: 'מותאם אישית',
};

/** YYYY-MM-DD for <input type="date" /> binding. */
export const toDateInput = (d: Date | null): string => {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** Parse a YYYY-MM-DD string from <input type="date"> back to a local Date (start of day). */
export const fromDateInput = (s: string): Date | null => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return startOfDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
};
