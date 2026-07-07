import { type CSSProperties, useEffect, useState } from 'react';
import {
  getHolidayCalendar,
  setHolidayPolicy,
  syncHolidays,
  type HolidayCalendarEntry,
  type HolidayPolicyState,
} from '../lib/api/holidays';
import { INK, MUTED, ORANGE, card as cardStyle } from './settings/shared';

// ---------------------------------------------------------------------------
// Jewish holidays + Shabbat closures (plan 2026-07-07-jewish-holidays-closures).
// Browse every holiday and Friday for a year and set each to רגיל / שעות
// מיוחדות / סגור. Hebcal supplies the dates + candle-lighting; a decision set
// here reapplies to the right (shifting) date every year. The venue only ever
// closes on a day Yanay explicitly chose — nothing is automatic.
// ---------------------------------------------------------------------------

const HE_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

const monthKeyOf = (iso: string): string => iso.slice(0, 7);
const monthLabelOf = (ym: string): string => `${HE_MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const fmtDayMonth = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const STATE_META: Record<HolidayPolicyState, { label: string; bg: string; color: string }> = {
  normal: { label: 'רגיל', bg: '#f0f5e3', color: '#6f8f37' },
  special_hours: { label: 'שעות מיוחדות', bg: '#fff4ee', color: '#c97a52' },
  closed: { label: 'סגור', bg: '#fbecec', color: '#c25a5a' },
};

function humanizeHolidayError(code: string): string {
  if (code === 'special_hours_needs_times') return 'לשעות מיוחדות צריך למלא שעת פתיחה וסגירה.';
  if (code === 'time_invalid') return 'שעה לא תקינה — שעת הסגירה חייבת להיות אחרי הפתיחה.';
  if (code === 'offset_invalid') return 'מספר הדקות לא תקין (0 עד 300).';
  if (code === 'not_found') return 'החג לא נמצא. הריצו סנכרון מ-Hebcal.';
  if (code === 'hebcal_unavailable') return 'לא ניתן להתחבר ל-Hebcal כרגע. נסו שוב בעוד רגע.';
  if (code === 'invalid_body') return 'נתונים לא תקינים. בדקו ונסו שוב.';
  if (code === 'forbidden') return 'רק אדמין יכול לערוך חגים.';
  return 'לא ניתן לשמור. נסו שוב בעוד רגע.';
}

const segBtn = (on: boolean, meta: { bg: string; color: string }): CSSProperties => ({
  border: `1.5px solid ${on ? meta.color : '#e9e0d9'}`,
  background: on ? meta.bg : '#fff',
  color: on ? meta.color : MUTED,
  borderRadius: 9,
  padding: '7px 13px',
  fontWeight: 600,
  fontSize: 13.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});
const timeInput: CSSProperties = {
  fontSize: 14,
  padding: '7px 10px',
  border: '1.5px solid #e9e0d9',
  borderRadius: 9,
  background: '#fff',
  outline: 'none',
};

function StateControl({
  value,
  disabled,
  onPick,
}: {
  value: HolidayPolicyState;
  disabled: boolean;
  onPick: (next: HolidayPolicyState) => void;
}) {
  const order: HolidayPolicyState[] = ['normal', 'special_hours', 'closed'];
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', opacity: disabled ? 0.6 : 1 }}>
      {order.map((s) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          onClick={() => value !== s && onPick(s)}
          style={segBtn(value === s, STATE_META[s])}
        >
          {STATE_META[s].label}
        </button>
      ))}
    </div>
  );
}

function HolidayRow({
  entry,
  year,
  onSaved,
}: {
  entry: HolidayCalendarEntry;
  year: number;
  onSaved: (updated: HolidayCalendarEntry) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isShabbat = entry.holidayKey === 'shabbat';

  const save = async (patch: Parameters<typeof setHolidayPolicy>[1], optimistic: HolidayCalendarEntry) => {
    setSaving(true);
    setError(null);
    onSaved(optimistic); // optimistic; reverted on error
    console.info('[web admin holidays] save', { key: entry.holidayKey, patch });
    const res = await setHolidayPolicy(entry.holidayKey, patch);
    setSaving(false);
    if (!res.ok) {
      console.warn('[web admin holidays] save error', { key: entry.holidayKey, error: res.error });
      setError(humanizeHolidayError(res.error));
      onSaved(entry); // revert to the last server-confirmed state
      return;
    }
    if (res.data.warning === 'rules_not_refreshed') {
      setError('נשמר, אך לוח הסבבים לא התרענן (Hebcal לא זמין). הריצו סנכרון שוב.');
    }
  };

  const pick = (next: HolidayPolicyState) => {
    if (next === 'special_hours' && !isShabbat) {
      const openTime = entry.openTime ?? '09:00';
      const closeTime = entry.closeTime ?? '13:00';
      void save(
        { year, policy: 'special_hours', openTime, closeTime, confirmed: true },
        { ...entry, policy: 'special_hours', openTime, closeTime, confirmed: true },
      );
      return;
    }
    if (next === 'special_hours' && isShabbat) {
      const offset = entry.shabbatCloseOffsetMinutes ?? 40;
      void save(
        { year, policy: 'special_hours', shabbatCloseOffsetMinutes: offset, confirmed: true },
        { ...entry, policy: 'special_hours', shabbatCloseOffsetMinutes: offset, confirmed: true },
      );
      return;
    }
    void save({ year, policy: next, confirmed: true }, { ...entry, policy: next, confirmed: true });
  };

  const setTime = (which: 'openTime' | 'closeTime', v: string) => {
    if (!v) return;
    void save({ year, [which]: v, confirmed: true }, { ...entry, [which]: v });
  };
  const setOffset = (v: number) => {
    if (!Number.isFinite(v)) return;
    void save(
      { year, shabbatCloseOffsetMinutes: v, confirmed: true },
      { ...entry, shabbatCloseOffsetMinutes: v },
    );
  };

  const dateLabel = isShabbat
    ? 'כל יום שישי'
    : entry.dates.map(fmtDayMonth).join(', ') || '—';

  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid #f3efea' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 160 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, color: INK, fontSize: 15 }}>{entry.hebrewName}</span>
            {entry.yomtov && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#b9772a',
                  background: '#fdf3e3',
                  borderRadius: 6,
                  padding: '2px 7px',
                }}
              >
                יום טוב
              </span>
            )}
            {!entry.confirmed && (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: '#c9861f' }}>• טרם הוחלט</span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3 }}>
            {dateLabel}
            {isShabbat && entry.dates.length > 0 ? ` · ${entry.dates.length} תאריכים השנה` : ''}
          </div>
        </div>
        <StateControl value={entry.policy} disabled={saving} onPick={pick} />
      </div>

      {entry.policy === 'special_hours' && !isShabbat && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13, color: MUTED, display: 'flex', alignItems: 'center', gap: 6 }}>
            פתיחה
            <input
              type="time"
              defaultValue={entry.openTime ?? '09:00'}
              disabled={saving}
              onBlur={(e) => setTime('openTime', e.target.value)}
              style={timeInput}
            />
          </label>
          <label style={{ fontSize: 13, color: MUTED, display: 'flex', alignItems: 'center', gap: 6 }}>
            סגירה
            <input
              type="time"
              defaultValue={entry.closeTime ?? '13:00'}
              disabled={saving}
              onBlur={(e) => setTime('closeTime', e.target.value)}
              style={timeInput}
            />
          </label>
        </div>
      )}

      {entry.policy === 'special_hours' && isShabbat && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: MUTED }}>סגירה</span>
          <input
            type="number"
            min={0}
            max={300}
            defaultValue={entry.shabbatCloseOffsetMinutes ?? 40}
            disabled={saving}
            onBlur={(e) => setOffset(Number(e.target.value))}
            style={{ ...timeInput, width: 72 }}
          />
          <span style={{ fontSize: 13, color: MUTED }}>דקות לפני הדלקת נרות (משתנה בכל שבוע)</span>
        </div>
      )}

      {error && <div style={{ fontSize: 12.5, color: '#a23a3a', marginTop: 8 }}>{error}</div>}
    </div>
  );
}

export function Holidays() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [entries, setEntries] = useState<HolidayCalendarEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = async (y: number) => {
    setEntries(null);
    setError(null);
    console.info('[web admin holidays] load', { year: y });
    const res = await getHolidayCalendar(y);
    if (res.ok) setEntries(res.data.entries);
    else setError(humanizeHolidayError(res.error));
  };

  useEffect(() => {
    void load(year);
  }, [year]);

  const runSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    console.info('[web admin holidays] sync', { year });
    const res = await syncHolidays(year);
    setSyncing(false);
    if (!res.ok) {
      setSyncMsg(humanizeHolidayError(res.error));
      return;
    }
    setSyncMsg(
      `סונכרן: ${res.data.holidays} חגים, ${res.data.fridays} שבתות. ${res.data.policiesInserted} חדשים.`,
    );
    void load(year);
  };

  const patchEntry = (updated: HolidayCalendarEntry) =>
    setEntries((prev) =>
      prev ? prev.map((e) => (e.holidayKey === updated.holidayKey ? updated : e)) : prev,
    );

  const shabbat = entries?.find((e) => e.holidayKey === 'shabbat') ?? null;
  const holidays = entries?.filter((e) => e.holidayKey !== 'shabbat') ?? [];
  // Group holidays by the month of their first date, preserving server order.
  const months: { ym: string; items: HolidayCalendarEntry[] }[] = [];
  for (const e of holidays) {
    const ym = monthKeyOf(e.dates[0] ?? `${year}-13`);
    const bucket = months.find((m) => m.ym === ym);
    if (bucket) bucket.items.push(e);
    else months.push({ ym, items: [e] });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={cardStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, color: INK }}>חגים ושבתות</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 3 }}>
              בחרו לכל חג ולשבת: רגיל, שעות מיוחדות, או סגור. ההחלטה חלה על אותו חג בכל שנה.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                onClick={() => setYear((y) => y - 1)}
                style={{ ...arrowBtn }}
                aria-label="שנה קודמת"
              >
                ›
              </button>
              <span style={{ fontWeight: 700, fontSize: 16, color: INK, minWidth: 52, textAlign: 'center' }}>
                {year}
              </span>
              <button
                type="button"
                onClick={() => setYear((y) => y + 1)}
                style={{ ...arrowBtn }}
                aria-label="שנה הבאה"
              >
                ‹
              </button>
            </div>
            <button type="button" onClick={() => void runSync()} disabled={syncing} style={syncButton(syncing)}>
              {syncing ? 'מסנכרן…' : 'סנכרון מ-Hebcal'}
            </button>
          </div>
        </div>
        {syncMsg && <div style={{ fontSize: 13, color: MUTED, marginTop: 10 }}>{syncMsg}</div>}
      </div>

      {error && <div style={{ ...cardStyle, color: '#a23a3a' }}>{error}</div>}
      {!error && entries === null && (
        <div style={{ ...cardStyle, color: MUTED, textAlign: 'center' }}>טוען…</div>
      )}

      {shabbat && (
        <div style={cardStyle}>
          <div style={{ fontWeight: 600, color: INK, marginBottom: 2 }}>שבת — כל שבוע</div>
          <HolidayRow entry={shabbat} year={year} onSaved={patchEntry} />
        </div>
      )}

      {entries !== null && holidays.length === 0 && (
        <div style={{ ...cardStyle, color: MUTED, textAlign: 'center' }}>
          אין חגים לשנה זו עדיין. לחצו על ״סנכרון מ-Hebcal״ כדי לטעון אותם.
        </div>
      )}

      {months.map((m) => (
        <div key={m.ym} style={cardStyle}>
          <div style={{ fontWeight: 700, color: '#b9772a', fontSize: 15, marginBottom: 4 }}>
            {monthLabelOf(m.ym)}
          </div>
          {m.items.map((e) => (
            <HolidayRow key={e.holidayKey} entry={e} year={year} onSaved={patchEntry} />
          ))}
        </div>
      ))}
    </div>
  );
}

const arrowBtn: CSSProperties = {
  width: 32,
  height: 32,
  border: '1.5px solid #e9e0d9',
  background: '#fff',
  borderRadius: 9,
  color: INK,
  fontSize: 18,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const syncButton = (busy: boolean): CSSProperties => ({
  border: 'none',
  background: ORANGE,
  color: '#fff',
  borderRadius: 10,
  padding: '9px 16px',
  fontWeight: 600,
  fontSize: 14,
  cursor: busy ? 'wait' : 'pointer',
  opacity: busy ? 0.7 : 1,
  whiteSpace: 'nowrap',
});
