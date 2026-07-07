import { useEffect, useState } from 'react';
import {
  getRoundSettings,
  updateRoundSettings,
  type RoundSettings,
  type RoundSettingsPatch,
} from '../../lib/api/round-settings';
import { BooleanField, card, MUTED, NumberField, SaveBar, SectionShell, TextField } from './shared';

// "סבבים" settings section (super-brief §15): the operational knobs the rounds
// flow reads at runtime — hold TTL, cancellation + claim windows, waitlist active
// hours, and the stay-duration reminder offsets. Self-contained like the other
// sections: loads and saves the round_settings singleton on its own.

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function humanizeError(code: string): string {
  if (code === 'hold_ttl_out_of_range') return 'משך הנעילה חייב להיות בין 1 ל-240 דקות.';
  if (code === 'cancellation_window_out_of_range') return 'חלון הביטול חייב להיות בין 0 ל-720 שעות.';
  if (code === 'claim_window_out_of_range') return 'חלון תפיסת המקום חייב להיות בין 1 ל-1440 דקות.';
  if (code === 'active_hours_out_of_range') return 'שעות הפעילות חייבות להיות בין 0 ל-23.';
  if (code === 'reminder_offsets_invalid')
    return 'זמני התזכורת: עד 5 מספרים, כל אחד בין 1 ל-240 דקות.';
  if (code === 'closing_time_invalid') return 'שעת הסגירה חייבת להיות בפורמט HH:MM.';
  if (code === 'invalid_body') return 'נתונים לא תקינים. בדקו ונסו שוב.';
  if (code === 'forbidden') return 'רק אדמין יכול לערוך הגדרות.';
  return 'לא ניתן לשמור את ההגדרות. נסו שוב בעוד רגע.';
}

// "30, 10" -> [30, 10]. Empty string -> [] (reminders off).
function parseOffsets(raw: string): number[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number);
}
const offsetsValid = (a: number[]): boolean =>
  a.length <= 5 && a.every((n) => Number.isInteger(n) && n >= 1 && n <= 240);

export function RoundSettingsSection() {
  const [loaded, setLoaded] = useState<RoundSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [holdTtl, setHoldTtl] = useState('15');
  const [cancelWindow, setCancelWindow] = useState('24');
  const [claimWindow, setClaimWindow] = useState('60');
  const [activeStart, setActiveStart] = useState('8');
  const [activeEnd, setActiveEnd] = useState('22');
  const [offsets, setOffsets] = useState('30, 10');
  const [closing, setClosing] = useState('19:00');
  const [skipLast, setSkipLast] = useState(true);
  const [allowOverCapacity, setAllowOverCapacity] = useState(true);
  const [warnUpcoming, setWarnUpcoming] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const hydrate = (s: RoundSettings) => {
    setHoldTtl(String(s.holdTtlMinutes));
    setCancelWindow(String(s.cancellationWindowHours));
    setClaimWindow(String(s.claimWindowMinutes));
    setActiveStart(String(s.activeHoursStart));
    setActiveEnd(String(s.activeHoursEnd));
    setOffsets(s.reminderOffsets.join(', '));
    setClosing(s.closingTime.slice(0, 5));
    setSkipLast(s.skipLastRoundReminder);
    setAllowOverCapacity(s.allowOverCapacityWalkIn);
    setWarnUpcoming(s.warnUpcomingReservationAtDoor);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getRoundSettings();
      if (cancelled) return;
      if (res.ok) {
        setLoaded(res.data.settings);
        hydrate(res.data.settings);
      } else {
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
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>סבבים</div>
        <div style={{ color: '#a23a3a', fontSize: 14 }}>
          {loadError === 'forbidden' ? 'רק אדמין יכול לפתוח מסך זה.' : 'לא ניתן לטעון הגדרות. רעננו את הדף.'}
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>סבבים</div>
        <div style={{ color: MUTED, fontSize: 14 }}>טוען…</div>
      </div>
    );
  }

  const parsedOffsets = parseOffsets(offsets);
  const offsetsOk = offsetsValid(parsedOffsets);
  const closingOk = HHMM_RE.test(closing);

  const offsetsChanged = JSON.stringify(parsedOffsets) !== JSON.stringify(loaded.reminderOffsets);
  const dirty =
    holdTtl !== String(loaded.holdTtlMinutes) ||
    cancelWindow !== String(loaded.cancellationWindowHours) ||
    claimWindow !== String(loaded.claimWindowMinutes) ||
    activeStart !== String(loaded.activeHoursStart) ||
    activeEnd !== String(loaded.activeHoursEnd) ||
    offsetsChanged ||
    closing !== loaded.closingTime.slice(0, 5) ||
    skipLast !== loaded.skipLastRoundReminder ||
    allowOverCapacity !== loaded.allowOverCapacityWalkIn ||
    warnUpcoming !== loaded.warnUpcomingReservationAtDoor;

  const submit = async () => {
    const patch: RoundSettingsPatch = {};
    const num = (s: string) => (Number.isInteger(Number(s)) && s.trim() !== '' ? Number(s) : null);
    const ttl = num(holdTtl);
    if (ttl !== null && ttl !== loaded.holdTtlMinutes) patch.holdTtlMinutes = ttl;
    const cw = num(cancelWindow);
    if (cw !== null && cw !== loaded.cancellationWindowHours) patch.cancellationWindowHours = cw;
    const clw = num(claimWindow);
    if (clw !== null && clw !== loaded.claimWindowMinutes) patch.claimWindowMinutes = clw;
    const as = num(activeStart);
    if (as !== null && as !== loaded.activeHoursStart) patch.activeHoursStart = as;
    const ae = num(activeEnd);
    if (ae !== null && ae !== loaded.activeHoursEnd) patch.activeHoursEnd = ae;
    if (offsetsChanged && offsetsOk) patch.reminderOffsets = parsedOffsets;
    if (closing !== loaded.closingTime.slice(0, 5) && closingOk) patch.closingTime = closing;
    if (skipLast !== loaded.skipLastRoundReminder) patch.skipLastRoundReminder = skipLast;
    if (allowOverCapacity !== loaded.allowOverCapacityWalkIn)
      patch.allowOverCapacityWalkIn = allowOverCapacity;
    if (warnUpcoming !== loaded.warnUpcomingReservationAtDoor)
      patch.warnUpcomingReservationAtDoor = warnUpcoming;
    if (Object.keys(patch).length === 0) return;

    setSubmitting(true);
    setError(null);
    const res = await updateRoundSettings(patch);
    setSubmitting(false);
    if (!res.ok) {
      setError(humanizeError(res.error));
      return;
    }
    setLoaded(res.data.settings);
    hydrate(res.data.settings);
    setFlash('הגדרות נשמרו');
    setTimeout(() => setFlash(null), 2500);
  };

  return (
    <SectionShell
      title="סבבים"
      description="הכללים התפעוליים של מערכת הסבבים: משך נעילת מקום, חלונות ביטול ותפיסה מרשימת המתנה, שעות שליחת התראות, ותזכורות סיום סבב."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
          <NumberField
            label="משך נעילת מקום"
            value={holdTtl}
            onChange={setHoldTtl}
            disabled={submitting}
            suffix="דקות"
            hint="כמה זמן מקום נשמר לפני תשלום. ברירת מחדל 15."
          />
          <NumberField
            label="חלון ביטול"
            value={cancelWindow}
            onChange={setCancelWindow}
            disabled={submitting}
            suffix="שעות"
            hint="עד כמה שעות לפני הסבב מותר לבטל בזיכוי. ברירת מחדל 24."
          />
          <NumberField
            label="חלון תפיסת מקום"
            value={claimWindow}
            onChange={setClaimWindow}
            disabled={submitting}
            suffix="דקות"
            hint="כמה זמן יש ללקוח לתפוס מקום שהתפנה מרשימת המתנה. ברירת מחדל 60."
          />
        </div>

        <div style={{ fontSize: 13.5, color: MUTED, fontWeight: 600, marginTop: 4 }}>
          שעות שליחת התראות רשימת המתנה
        </div>
        <div style={{ fontSize: 12.5, color: MUTED }}>
          מקום שמתפנה מחוץ לשעות האלה ימתין לבוקר. שעון מקומי (0–23).
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
          <NumberField
            label="תחילת שעות פעילות"
            value={activeStart}
            onChange={setActiveStart}
            disabled={submitting}
            hint="ברירת מחדל 8 (08:00)."
          />
          <NumberField
            label="סוף שעות פעילות"
            value={activeEnd}
            onChange={setActiveEnd}
            disabled={submitting}
            hint="ברירת מחדל 22 (22:00)."
          />
        </div>

        <div style={{ fontSize: 13.5, color: MUTED, fontWeight: 600, marginTop: 8 }}>
          תזכורות סיום סבב
        </div>
        <TextField
          label="דקות לפני סוף הסבב לתזכורת"
          value={offsets}
          onChange={setOffsets}
          disabled={submitting}
          hint='רשימה מופרדת בפסיקים, למשל "30, 10". השאירו ריק כדי לכבות תזכורות. עד 5 ערכים.'
        />
        {!offsetsOk && (
          <div style={{ fontSize: 13, color: '#a23a3a' }} role="alert">
            זמני התזכורת: עד 5 מספרים, כל אחד בין 1 ל-240 דקות.
          </div>
        )}
        <TextField
          label="שעת סגירת המקום"
          value={closing}
          onChange={setClosing}
          disabled={submitting}
          maxLength={5}
          hint="פורמט HH:MM (למשל 19:00). משמש לזיהוי הסבב האחרון של היום."
        />
        {!closingOk && (
          <div style={{ fontSize: 13, color: '#a23a3a' }} role="alert">
            שעת הסגירה חייבת להיות בפורמט HH:MM.
          </div>
        )}
        <BooleanField
          label="דילוג תזכורת לסבב האחרון"
          description="לא לשלוח תזכורת סיום לסבב האחרון של היום — המקום נסגר ממילא, אז זו הודעה מיותרת."
          checked={skipLast}
          onChange={setSkipLast}
          disabled={submitting}
        />

        <div style={{ fontSize: 13.5, color: MUTED, fontWeight: 600, marginTop: 8 }}>
          ניהול משתתפים בסבב
        </div>
        <BooleanField
          label="הוספה ידנית מעל התפוסה"
          description="לאפשר לצוות להוסיף משתתף לסבב גם כשהוא מלא. הנוספים מסומנים בנפרד מהנרשמים. כשמכובה — סבב מלא לא יקבל הוספה ידנית."
          checked={allowOverCapacity}
          onChange={setAllowOverCapacity}
          disabled={submitting}
        />
        <BooleanField
          label="התראה בקופה על הזמנה עתידית"
          description="כשסורקים כרטיסייה בקופה, להציג התראה אם ללקוח יש כבר סבב עתידי שהוזמן — כדי שלא ינצל את כל הכניסות לפני התאריך."
          checked={warnUpcoming}
          onChange={setWarnUpcoming}
          disabled={submitting}
        />
      </div>
      <SaveBar
        dirty={dirty && offsetsOk && closingOk}
        submitting={submitting}
        error={error}
        flash={flash}
        onSubmit={submit}
      />
    </SectionShell>
  );
}
