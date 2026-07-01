import { type CSSProperties, useEffect, useState } from 'react';
import {
  getDashboardSettings,
  updateDashboardSettings,
  type DashboardSettings,
  type DashboardSettingsPatch,
} from '../../lib/api/admin';
import { BooleanField, card, INK, MUTED, NumberField, SaveBar, SectionShell } from './shared';

// ---------------------------------------------------------------------------
// "דשבורד" settings section (Super Brief §15.3). Self-contained: loads and
// saves the dashboard_settings singleton on its own, independent of the card
// settings the rest of the Settings tab is built around. Every field here
// drives the live rounds dashboard end-to-end.
// ---------------------------------------------------------------------------

// Canonical zone list + Hebrew labels. The live order/visibility comes from
// settings.widgetsOrder; this is only the label lookup + the "add back" pool.
const WIDGET_LABELS: Record<string, string> = {
  rounds_today: 'סבבי היום',
  stats_today: 'היום במספרים',
  alerts: 'התראות',
  waitlist: 'רשימת המתנה',
  week_ahead: '7 ימים קדימה',
};
const ALL_WIDGET_KEYS = ['rounds_today', 'stats_today', 'alerts', 'waitlist', 'week_ahead'];

function humanizeDashboardError(code: string): string {
  if (code === 'refresh_interval_out_of_range') return 'קצב הרענון חייב להיות בין 5 ל-3600 שניות.';
  if (code === 'capacity_warning_out_of_range') return 'סף הצהוב חייב להיות בין 0 ל-100 אחוז.';
  if (code === 'capacity_danger_out_of_range') return 'סף האדום חייב להיות בין 0 ל-100 אחוז.';
  if (code === 'capacity_warning_above_danger') return 'סף הצהוב חייב להיות נמוך או שווה לסף האדום.';
  if (code === 'widgets_order_unknown_key') return 'זן לא מוכר בסדר התצוגה.';
  if (code === 'widgets_order_duplicate_key') return 'זן מופיע פעמיים בסדר התצוגה.';
  if (code === 'invalid_body') return 'נתונים לא תקינים. בדקו ונסו שוב.';
  if (code === 'forbidden') return 'רק אדמין יכול לערוך הגדרות.';
  return 'לא ניתן לשמור את ההגדרות. נסו שוב בעוד רגע.';
}

const stepBtn = (disabled: boolean): CSSProperties => ({
  border: '1.5px solid #e9e0d9',
  background: '#fff',
  color: MUTED,
  borderRadius: 8,
  width: 30,
  height: 30,
  fontSize: 15,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1,
});
const linkBtn: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#c97a52',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
};

export function DashboardSettingsSection() {
  const [loaded, setLoaded] = useState<DashboardSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [refresh, setRefresh] = useState('30');
  const [showRevenue, setShowRevenue] = useState(true);
  const [showWeekAhead, setShowWeekAhead] = useState(true);
  const [warn, setWarn] = useState('70');
  const [danger, setDanger] = useState('90');
  const [order, setOrder] = useState<string[]>(ALL_WIDGET_KEYS);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const hydrate = (s: DashboardSettings) => {
    setRefresh(String(s.refreshIntervalSeconds));
    setShowRevenue(s.showRevenue);
    setShowWeekAhead(s.showWeekAhead);
    setWarn(String(s.capacityWarningPct));
    setDanger(String(s.capacityDangerPct));
    setOrder(s.widgetsOrder);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      console.info('[web admin dashboard-settings] load');
      const res = await getDashboardSettings();
      if (cancelled) return;
      if (res.ok) {
        setLoaded(res.data.settings);
        hydrate(res.data.settings);
      } else {
        console.warn('[web admin dashboard-settings] load failed', { error: res.error });
        setLoadError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>דשבורד</div>
        <div style={{ color: '#a23a3a', fontSize: 14 }}>
          {loadError === 'forbidden' ? 'רק אדמין יכול לפתוח מסך זה.' : 'לא ניתן לטעון הגדרות. רעננו את הדף.'}
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>דשבורד</div>
        <div style={{ color: MUTED, fontSize: 14 }}>טוען…</div>
      </div>
    );
  }

  const refreshNum = Number(refresh);
  const warnNum = Number(warn);
  const dangerNum = Number(danger);
  const warnAboveDanger =
    Number.isInteger(warnNum) && Number.isInteger(dangerNum) && warnNum > dangerNum;

  const orderChanged =
    order.length !== loaded.widgetsOrder.length ||
    order.some((k, i) => k !== loaded.widgetsOrder[i]);

  const dirty =
    refresh !== String(loaded.refreshIntervalSeconds) ||
    showRevenue !== loaded.showRevenue ||
    showWeekAhead !== loaded.showWeekAhead ||
    warn !== String(loaded.capacityWarningPct) ||
    danger !== String(loaded.capacityDangerPct) ||
    orderChanged;

  const hidden = ALL_WIDGET_KEYS.filter((k) => !order.includes(k));

  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    const a = next[idx];
    const b = next[j];
    if (a === undefined || b === undefined) return;
    next[idx] = b;
    next[j] = a;
    setOrder(next);
  };
  const hide = (key: string) => setOrder(order.filter((k) => k !== key));
  const show = (key: string) => setOrder([...order, key]);

  const submit = async () => {
    const patch: DashboardSettingsPatch = {};
    if (Number.isInteger(refreshNum) && refreshNum !== loaded.refreshIntervalSeconds)
      patch.refreshIntervalSeconds = refreshNum;
    if (showRevenue !== loaded.showRevenue) patch.showRevenue = showRevenue;
    if (showWeekAhead !== loaded.showWeekAhead) patch.showWeekAhead = showWeekAhead;
    if (Number.isInteger(warnNum) && warnNum !== loaded.capacityWarningPct)
      patch.capacityWarningPct = warnNum;
    if (Number.isInteger(dangerNum) && dangerNum !== loaded.capacityDangerPct)
      patch.capacityDangerPct = dangerNum;
    if (orderChanged) patch.widgetsOrder = order;
    if (Object.keys(patch).length === 0) return;

    setSubmitting(true);
    setError(null);
    console.info('[web admin dashboard-settings] save', { fields: Object.keys(patch) });
    const res = await updateDashboardSettings(patch);
    setSubmitting(false);
    if (!res.ok) {
      console.warn('[web admin dashboard-settings] save failed', { error: res.error });
      setError(humanizeDashboardError(res.error));
      return;
    }
    console.info('[web admin dashboard-settings] save ok', { diff: res.data.diff });
    setLoaded(res.data.settings);
    hydrate(res.data.settings);
    setFlash('הגדרות נשמרו');
    setTimeout(() => setFlash(null), 2500);
  };

  return (
    <SectionShell
      title="דשבורד"
      description="שולט במראה ובקצב של לוח הבקרה שנפתח בכניסה לאדמין. השינויים חלים על כל מי שצופה בלוח, בתוך רענון אחד."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <NumberField
          label="קצב רענון אוטומטי"
          value={refresh}
          onChange={setRefresh}
          disabled={submitting}
          suffix="שניות"
          hint="כל כמה זמן הלוח מושך נתונים חדשים. טווח: 5 עד 3600 שניות."
        />

        <BooleanField
          label="הצגת הכנסות בלוח"
          description="כשמכובה, מטריקת ההכנסה נעלמת מהלוח לכל הצופים. שימושי כשעובד לא-מורשה עשוי לראות את המסך. הנתון מוסתר בצד השרת, לא רק בתצוגה."
          checked={showRevenue}
          onChange={setShowRevenue}
          disabled={submitting}
        />
        <BooleanField
          label="הצגת '7 ימים קדימה'"
          description="הצגה או הסתרה של רשת התפוסה לשבוע הקרוב בתחתית הלוח."
          checked={showWeekAhead}
          onChange={setShowWeekAhead}
          disabled={submitting}
        />

        <div style={{ fontSize: 13.5, color: MUTED, fontWeight: 600, marginTop: 4 }}>
          ספי צבע לתפוסת סבב
        </div>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}
        >
          <NumberField
            label="סף צהוב (אזהרה)"
            value={warn}
            onChange={setWarn}
            disabled={submitting}
            suffix="%"
            hint="מעל אחוז זה הסבב מסומן בצהוב. ברירת מחדל 70."
          />
          <NumberField
            label="סף אדום (כמעט מלא)"
            value={danger}
            onChange={setDanger}
            disabled={submitting}
            suffix="%"
            hint="מעל אחוז זה הסבב מסומן באדום. ברירת מחדל 90."
          />
        </div>
        {warnAboveDanger && (
          <div style={{ fontSize: 13, color: '#a23a3a' }} role="alert">
            סף הצהוב חייב להיות נמוך או שווה לסף האדום.
          </div>
        )}

        <div style={{ fontSize: 13.5, color: MUTED, fontWeight: 600, marginTop: 8 }}>
          סדר וזמינות הזונים
        </div>
        <div style={{ fontSize: 12.5, color: MUTED }}>
          הזונים מופיעים בלוח בסדר הזה מלמעלה למטה. כבו זן כדי להסתיר אותו לגמרי.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {order.map((key, idx) => (
            <div
              key={key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                border: '1px solid #f3efea',
                borderRadius: 10,
              }}
            >
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  aria-label="הזז למעלה"
                  style={stepBtn(idx === 0 || submitting)}
                  disabled={idx === 0 || submitting}
                  onClick={() => move(idx, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="הזז למטה"
                  style={stepBtn(idx === order.length - 1 || submitting)}
                  disabled={idx === order.length - 1 || submitting}
                  onClick={() => move(idx, 1)}
                >
                  ↓
                </button>
              </div>
              <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: INK }}>
                {WIDGET_LABELS[key] ?? key}
              </span>
              <button type="button" style={linkBtn} disabled={submitting} onClick={() => hide(key)}>
                הסתר
              </button>
            </div>
          ))}
        </div>
        {order.length === 0 && (
          <div style={{ fontSize: 13, color: '#a23a3a' }} role="alert">
            הסתרתם את כל הזונים — הלוח יופיע ריק. החזירו לפחות זן אחד.
          </div>
        )}
        {hidden.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 6 }}>מוסתרים</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {hidden.map((key) => (
                <div
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    border: '1px dashed #ececec',
                    borderRadius: 10,
                  }}
                >
                  <span style={{ flex: 1, fontSize: 14, color: MUTED }}>
                    {WIDGET_LABELS[key] ?? key}
                  </span>
                  <button type="button" style={linkBtn} disabled={submitting} onClick={() => show(key)}>
                    הצג
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <SaveBar
        dirty={dirty && !warnAboveDanger && order.length > 0}
        submitting={submitting}
        error={error}
        flash={flash}
        onSubmit={submit}
      />
    </SectionShell>
  );
}
