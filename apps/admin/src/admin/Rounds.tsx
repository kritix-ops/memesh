import { type CSSProperties, useEffect, useState } from 'react';
import {
  createRound,
  listRounds,
  updateRound,
  type AdminRound,
  type RoundInput,
  type RoundPatch,
} from '../lib/api/rounds';
import {
  BooleanField,
  INK,
  MUTED,
  NumberField,
  ORANGE,
  SaveBar,
  TextField,
  card as cardStyle,
} from './settings/shared';

// ---------------------------------------------------------------------------
// Rounds management (super-brief §11.1.2). Define the round templates:
// display name, internal label, start/end time, active weekdays, default
// capacity, active toggle, sort order. Creating/editing a template also
// materializes its upcoming instances server-side, so a saved round appears on
// the dashboard immediately. Per-date overrides/closures are the next step.
// ---------------------------------------------------------------------------

const WEEKDAYS: { bit: number; label: string; full: string }[] = [
  { bit: 0, label: 'א׳', full: 'ראשון' },
  { bit: 1, label: 'ב׳', full: 'שני' },
  { bit: 2, label: 'ג׳', full: 'שלישי' },
  { bit: 3, label: 'ד׳', full: 'רביעי' },
  { bit: 4, label: 'ה׳', full: 'חמישי' },
  { bit: 5, label: 'ו׳', full: 'שישי' },
  { bit: 6, label: 'ש׳', full: 'שבת' },
];

function daysSummary(mask: number): string {
  if (mask === 127) return 'כל השבוע';
  const active = WEEKDAYS.filter((d) => (mask & (1 << d.bit)) !== 0).map((d) => d.label);
  return active.length ? active.join(' ') : 'אף יום';
}

function humanizeRoundError(code: string): string {
  if (code === 'label_length') return 'תווית פנימית חייבת לכלול בין תו אחד ל-64 תווים.';
  if (code === 'display_name_length') return 'שם הסבב חייב לכלול בין תו אחד ל-128 תווים.';
  if (code === 'invalid_start_time') return 'שעת התחלה לא תקינה (פורמט HH:MM).';
  if (code === 'invalid_end_time') return 'שעת סיום לא תקינה (פורמט HH:MM).';
  if (code === 'end_not_after_start') return 'שעת הסיום חייבת להיות אחרי שעת ההתחלה.';
  if (code === 'capacity_out_of_range') return 'קיבולת חייבת להיות מספר שלם בין 1 ל-100,000.';
  if (code === 'days_active_out_of_range') return 'יש לבחור לפחות יום פעילות אחד.';
  if (code === 'sort_order_invalid') return 'סדר מיון לא תקין.';
  if (code === 'not_found') return 'הסבב לא נמצא. ייתכן שנמחק.';
  if (code === 'invalid_body') return 'נתונים לא תקינים. בדקו ונסו שוב.';
  if (code === 'forbidden') return 'רק אדמין יכול לערוך סבבים.';
  return 'לא ניתן לשמור. נסו שוב בעוד רגע.';
}

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
  padding: '10px 18px',
  fontSize: 14,
  cursor: 'pointer',
};

export function Rounds() {
  const [rounds, setRounds] = useState<AdminRound[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // null = list view; 'new' = create form; an AdminRound = edit form.
  const [editing, setEditing] = useState<AdminRound | 'new' | null>(null);

  const reload = async () => {
    const res = await listRounds();
    if (res.ok) {
      setRounds(res.data.rounds);
      setLoadError(null);
    } else {
      setLoadError(res.error);
      console.warn('[web admin rounds] load failed', { error: res.error });
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  if (editing !== null) {
    return (
      <RoundForm
        initial={editing === 'new' ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: INK }}>סבבים</div>
        <button type="button" style={primaryBtn} onClick={() => setEditing('new')}>
          + סבב חדש
        </button>
      </div>

      {loadError ? (
        <div style={{ ...cardStyle, color: '#a23a3a' }}>
          {loadError === 'forbidden' ? 'רק אדמין יכול לפתוח מסך זה.' : 'לא ניתן לטעון סבבים. רעננו את הדף.'}
        </div>
      ) : !rounds ? (
        <div style={{ ...cardStyle, color: MUTED, textAlign: 'center' }}>טוען…</div>
      ) : rounds.length === 0 ? (
        <div style={{ ...cardStyle, textAlign: 'center', color: MUTED }}>
          עדיין לא הוגדרו סבבים. צרו את הסבב הראשון כדי שיופיע בלוח הבקרה ובקופה.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rounds.map((r) => (
            <div key={r.id} style={cardStyle}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: INK }}>
                    {r.displayName}
                    {!r.isActive && (
                      <span style={{ color: MUTED, fontWeight: 400, fontSize: 13, marginInlineStart: 8 }}>
                        (מושבת)
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13.5, color: MUTED, marginTop: 4 }}>
                    {r.startTime}–{r.endTime} · {daysSummary(r.daysActive)} · קיבולת {r.defaultCapacity}
                  </div>
                  <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                    {r.upcomingInstances ?? 0} תאריכים קרובים · תווית: {r.label}
                  </div>
                </div>
                <button type="button" style={ghostBtn} onClick={() => setEditing(r)}>
                  עריכה
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RoundForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: AdminRound | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isNew = initial === null;
  const [label, setLabel] = useState(initial?.label ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [startTime, setStartTime] = useState(initial?.startTime ?? '16:00');
  const [endTime, setEndTime] = useState(initial?.endTime ?? '18:00');
  const [days, setDays] = useState(initial?.daysActive ?? 127);
  const [capacity, setCapacity] = useState(String(initial?.defaultCapacity ?? 50));
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const toggleDay = (bit: number) => setDays((prev) => prev ^ (1 << bit));

  const cap = Number(capacity);
  const sort = Number(sortOrder);
  const capValid = Number.isInteger(cap) && cap >= 1;
  const requiredFilled = displayName.trim().length > 0 && label.trim().length > 0;

  const dirty = isNew
    ? true
    : label.trim() !== initial.label ||
      displayName.trim() !== initial.displayName ||
      startTime !== initial.startTime ||
      endTime !== initial.endTime ||
      days !== initial.daysActive ||
      (capValid && cap !== initial.defaultCapacity) ||
      isActive !== initial.isActive ||
      (Number.isInteger(sort) && sort !== initial.sortOrder);

  const canSave = requiredFilled && capValid && days >= 1;

  const submit = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    let res;
    if (isNew) {
      const input: RoundInput = {
        label: label.trim(),
        displayName: displayName.trim(),
        startTime,
        endTime,
        daysActive: days,
        defaultCapacity: cap,
        isActive,
        sortOrder: Number.isInteger(sort) ? sort : 0,
      };
      console.info('[web admin rounds] create', { displayName: input.displayName });
      res = await createRound(input);
    } else {
      const patch: RoundPatch = {};
      if (label.trim() !== initial.label) patch.label = label.trim();
      if (displayName.trim() !== initial.displayName) patch.displayName = displayName.trim();
      if (startTime !== initial.startTime) patch.startTime = startTime;
      if (endTime !== initial.endTime) patch.endTime = endTime;
      if (days !== initial.daysActive) patch.daysActive = days;
      if (capValid && cap !== initial.defaultCapacity) patch.defaultCapacity = cap;
      if (isActive !== initial.isActive) patch.isActive = isActive;
      if (Number.isInteger(sort) && sort !== initial.sortOrder) patch.sortOrder = sort;
      if (Object.keys(patch).length === 0) {
        setSubmitting(false);
        onSaved();
        return;
      }
      console.info('[web admin rounds] update', { id: initial.id, fields: Object.keys(patch) });
      res = await updateRound(initial.id, patch);
    }
    setSubmitting(false);
    if (!res.ok) {
      console.warn('[web admin rounds] save failed', { error: res.error });
      setError(humanizeRoundError(res.error));
      return;
    }
    setFlash('הסבב נשמר');
    setTimeout(onSaved, 600);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: INK }}>
          {isNew ? 'סבב חדש' : 'עריכת סבב'}
        </div>
        <button type="button" style={ghostBtn} onClick={onCancel} disabled={submitting}>
          חזרה לרשימה
        </button>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <TextField
            label="שם הסבב (מוצג ללקוח)"
            value={displayName}
            onChange={setDisplayName}
            disabled={submitting}
            hint='למשל: "סבב אחר הצהריים".'
            maxLength={128}
          />
          <TextField
            label="תווית פנימית"
            value={label}
            onChange={setLabel}
            disabled={submitting}
            hint='מזהה קצר לשימוש פנימי, למשל "afternoon". לא מוצג ללקוח.'
            maxLength={64}
          />
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14 }}
          >
            <TextField
              label="שעת התחלה"
              value={startTime}
              onChange={setStartTime}
              disabled={submitting}
              hint="פורמט HH:MM"
              maxLength={5}
            />
            <TextField
              label="שעת סיום"
              value={endTime}
              onChange={setEndTime}
              disabled={submitting}
              hint="פורמט HH:MM"
              maxLength={5}
            />
          </div>

          <div>
            <div style={{ fontSize: 13.5, color: MUTED, marginBottom: 8 }}>ימי פעילות</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {WEEKDAYS.map((d) => {
                const active = (days & (1 << d.bit)) !== 0;
                return (
                  <button
                    key={d.bit}
                    type="button"
                    onClick={() => toggleDay(d.bit)}
                    disabled={submitting}
                    aria-pressed={active}
                    title={d.full}
                    style={{
                      border: active ? `1.5px solid ${ORANGE}` : '1.5px solid #e9e0d9',
                      background: active ? '#fff4ee' : '#fff',
                      color: active ? '#c97a52' : MUTED,
                      borderRadius: 999,
                      width: 46,
                      padding: '9px 0',
                      fontWeight: 600,
                      fontSize: 14,
                      cursor: submitting ? 'default' : 'pointer',
                    }}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            {days < 1 && (
              <div style={{ fontSize: 13, color: '#a23a3a', marginTop: 6 }}>
                יש לבחור לפחות יום אחד.
              </div>
            )}
          </div>

          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14 }}
          >
            <NumberField
              label="קיבולת ברירת מחדל"
              value={capacity}
              onChange={setCapacity}
              disabled={submitting}
              suffix="ילדים"
              hint="מספר הילדים המרבי בסבב. חל על תאריכים חדשים; לתאריך קיים ערכו את הקיבולת פר-תאריך."
            />
            <NumberField
              label="סדר מיון"
              value={sortOrder}
              onChange={setSortOrder}
              disabled={submitting}
              hint="קובע את סדר הצגת הסבבים. נמוך = קודם."
            />
          </div>

          <BooleanField
            label="סבב פעיל"
            description="כשמכובה, הסבב לא מייצר תאריכים חדשים ולא מוצג בלוח. תאריכים והזמנות קיימים נשמרים."
            checked={isActive}
            onChange={setIsActive}
            disabled={submitting}
          />
        </div>

        <SaveBar
          dirty={dirty && canSave}
          submitting={submitting}
          error={error}
          flash={flash}
          onSubmit={submit}
        />
      </div>
    </div>
  );
}
