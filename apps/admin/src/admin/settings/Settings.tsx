import { type CSSProperties, useEffect, useState } from 'react';
import {
  formatHHMM,
  getCardSettings as fetchCardSettings,
  parseHHMM,
  updateCardSettings,
  type CancelRole,
  type CardSettings,
  type CardSettingsPatch,
} from '../../lib/api/card-settings';
import {
  BooleanField,
  MUTED,
  NumberField,
  ORANGE,
  SaveBar,
  SectionShell,
  SelectField,
  SHADOW,
  TextAreaField,
  TextField,
  card as cardStyle,
  humanizeSettingsError,
} from './shared';

type SectionKey =
  | 'pricing'
  | 'mechanics'
  | 'cancel'
  | 'sms'
  | 'operations'
  | 'pos-controls'
  | 'thankyou';

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'pricing', label: 'כרטיסייה' },
  { key: 'mechanics', label: 'כללי כרטיסייה' },
  { key: 'cancel', label: 'ביטולים' },
  { key: 'sms', label: 'הודעות SMS' },
  { key: 'operations', label: 'חוויית קופה ולקוחות' },
  { key: 'pos-controls', label: 'קופה ובקרה' },
  { key: 'thankyou', label: 'דף תודה' },
];

const subNavStyle = (active: boolean): CSSProperties => ({
  display: 'block',
  width: '100%',
  textAlign: 'right',
  background: active ? '#fff4ee' : 'transparent',
  color: active ? '#c97a52' : MUTED,
  border: 'none',
  borderRadius: 10,
  padding: '10px 12px',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  position: 'relative',
  paddingInlineStart: 26,
});

const dotStyle = (active: boolean): CSSProperties => ({
  position: 'absolute',
  insetInlineStart: 10,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 8,
  height: 8,
  borderRadius: 4,
  background: active ? ORANGE : '#dfe3e3',
});

export function Settings() {
  const [loaded, setLoaded] = useState<CardSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<SectionKey>('pricing');

  const reload = async () => {
    const res = await fetchCardSettings();
    if (res.ok) {
      setLoaded(res.data.settings);
      setLoadError(null);
    } else {
      setLoadError(res.error);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      console.info('[web admin settings] load');
      const res = await fetchCardSettings();
      if (cancelled) return;
      if (res.ok) {
        setLoaded(res.data.settings);
      } else {
        console.warn('[web admin settings] load failed', { error: res.error });
        setLoadError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>הגדרות</div>
        <div style={{ color: '#a23a3a', fontSize: 14 }}>
          לא ניתן לטעון הגדרות.{' '}
          {loadError === 'forbidden' ? 'רק אדמין יכול לפתוח מסך זה.' : 'רעננו את הדף.'}
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>הגדרות</div>
        <div style={{ color: MUTED, fontSize: 14 }}>טוען…</div>
      </div>
    );
  }

  const onSaved = (next: CardSettings) => setLoaded(next);

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <nav
        style={{
          ...cardStyle,
          padding: 10,
          width: 210,
          flexShrink: 0,
          alignSelf: 'flex-start',
          boxShadow: SHADOW,
        }}
        aria-label="הגדרות"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActive(s.key)}
            style={subNavStyle(active === s.key)}
            aria-current={active === s.key ? 'page' : undefined}
          >
            <span style={dotStyle(active === s.key)} />
            {s.label}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, minWidth: 0 }}>
        {active === 'pricing' && <PricingSection loaded={loaded} onSaved={onSaved} reload={reload} />}
        {active === 'mechanics' && (
          <MechanicsSection loaded={loaded} onSaved={onSaved} reload={reload} />
        )}
        {active === 'cancel' && <CancelSection loaded={loaded} onSaved={onSaved} reload={reload} />}
        {active === 'sms' && <SmsSection loaded={loaded} onSaved={onSaved} reload={reload} />}
        {active === 'operations' && (
          <OperationsSection loaded={loaded} onSaved={onSaved} reload={reload} />
        )}
        {active === 'pos-controls' && (
          <PosControlsSection loaded={loaded} onSaved={onSaved} reload={reload} />
        )}
        {active === 'thankyou' && (
          <ThankyouSection loaded={loaded} onSaved={onSaved} reload={reload} />
        )}
      </div>
    </div>
  );
}

// Shared per-section save helper. Returns either a fresh `loaded` snapshot or
// surfaces the server error string. `reload` is used after `no_changes` so the
// form snaps back to the server's canonical values.
function useSectionSave(
  onSaved: (next: CardSettings) => void,
  reload: () => Promise<void>,
) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const save = async (patch: CardSettingsPatch, sectionLog: string) => {
    setSubmitting(true);
    setError(null);
    console.info(`[web admin settings] save ${sectionLog}`, { fields: Object.keys(patch) });
    const res = await updateCardSettings(patch);
    setSubmitting(false);
    if (!res.ok) {
      console.warn(`[web admin settings] save ${sectionLog} failed`, { error: res.error });
      if (res.error === 'no_changes') {
        await reload();
      }
      setError(humanizeSettingsError(res.error));
      return false;
    }
    console.info(`[web admin settings] save ${sectionLog} ok`, { diff: res.data.diff });
    onSaved(res.data.settings);
    setFlash('הגדרות נשמרו');
    setTimeout(() => setFlash(null), 2500);
    return true;
  };

  return { submitting, error, flash, save };
}

// ---------------------------------------------------------------------------
// Pricing — existing 4 fields
// ---------------------------------------------------------------------------

function PricingSection({
  loaded,
  onSaved,
  reload,
}: {
  loaded: CardSettings;
  onSaved: (next: CardSettings) => void;
  reload: () => Promise<void>;
}) {
  // validityDays=0 is the "forever" sentinel on the server. In the UI we
  // expose it as a separate boolean toggle that disables the days input, so
  // the cashier doesn't have to know the convention.
  const [price, setPrice] = useState(String(loaded.priceShekels));
  const [forever, setForever] = useState(loaded.validityDays === 0);
  const [validityDraft, setValidityDraft] = useState(
    loaded.validityDays === 0 ? '365' : String(loaded.validityDays),
  );
  const [entries, setEntries] = useState(String(loaded.totalEntries));
  const [pitch, setPitch] = useState(loaded.pitchLabel);
  const { submitting, error, flash, save } = useSectionSave(onSaved, reload);

  useEffect(() => {
    setPrice(String(loaded.priceShekels));
    setForever(loaded.validityDays === 0);
    setValidityDraft(loaded.validityDays === 0 ? '365' : String(loaded.validityDays));
    setEntries(String(loaded.totalEntries));
    setPitch(loaded.pitchLabel);
  }, [loaded]);

  const effectiveValidity = forever ? 0 : Number(validityDraft);

  const dirty =
    price !== String(loaded.priceShekels) ||
    effectiveValidity !== loaded.validityDays ||
    entries !== String(loaded.totalEntries) ||
    pitch !== loaded.pitchLabel;

  const submit = async () => {
    const patch: CardSettingsPatch = {};
    const p = Number(price);
    const e = Number(entries);
    if (!Number.isInteger(p) || !Number.isInteger(e)) return;
    if (!forever && !Number.isInteger(effectiveValidity)) return;
    if (p !== loaded.priceShekels) patch.priceShekels = p;
    if (effectiveValidity !== loaded.validityDays) patch.validityDays = effectiveValidity;
    if (e !== loaded.totalEntries) patch.totalEntries = e;
    if (pitch.trim() !== loaded.pitchLabel) patch.pitchLabel = pitch.trim();
    await save(patch, 'pricing');
  };

  return (
    <SectionShell
      title="הגדרות כרטיסייה"
      description="ערכים אלה חלים על כרטיסיות חדשות בלבד. כרטיסיות שכבר נמכרו שומרות את הערכים המקוריים."
    >
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}
      >
        <NumberField label="מחיר (₪)" value={price} onChange={setPrice} disabled={submitting} />
        <NumberField
          label="תוקף כרטיסייה (ימים)"
          value={forever ? '' : validityDraft}
          onChange={setValidityDraft}
          disabled={submitting || forever}
          suffix="ימים"
          {...(forever && { hint: 'מבוטל — הכרטיסייה ללא תאריך תפוגה.' })}
        />
        <NumberField
          label="כניסות בכרטיסייה"
          value={entries}
          onChange={setEntries}
          disabled={submitting}
        />
      </div>
      <div style={{ marginTop: 14 }}>
        <BooleanField
          label="ללא תפוגה (כרטיסייה לכל החיים)"
          description="כשמופעל, כרטיסיות חדשות נוצרות ללא תאריך תפוגה. ניתן לבטל או לסיים ניצול בלבד."
          checked={forever}
          onChange={setForever}
          disabled={submitting}
        />
      </div>
      <div style={{ marginTop: 14 }}>
        <TextField
          label="טקסט שיווקי בקופה"
          value={pitch}
          onChange={setPitch}
          disabled={submitting}
          hint="נראה ללקוח במסך מכירת הכרטיסייה."
          maxLength={200}
        />
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Mechanics — lockout + grace. The cashier picks how many entries to consume
// per scan at the till (bounded by the card's remaining entries); no admin
// cap on per-scan count today.
// ---------------------------------------------------------------------------

function MechanicsSection({
  loaded,
  onSaved,
  reload,
}: {
  loaded: CardSettings;
  onSaved: (next: CardSettings) => void;
  reload: () => Promise<void>;
}) {
  const [lockout, setLockout] = useState(String(loaded.sameDayLockoutMinutes));
  const [grace, setGrace] = useState(String(loaded.gracePeriodDays));
  const { submitting, error, flash, save } = useSectionSave(onSaved, reload);

  useEffect(() => {
    setLockout(String(loaded.sameDayLockoutMinutes));
    setGrace(String(loaded.gracePeriodDays));
  }, [loaded]);

  const dirty =
    lockout !== String(loaded.sameDayLockoutMinutes) ||
    grace !== String(loaded.gracePeriodDays);

  const submit = async () => {
    const patch: CardSettingsPatch = {};
    const lk = Number(lockout);
    const gr = Number(grace);
    if ([lk, gr].some((n) => !Number.isInteger(n))) return;
    if (lk !== loaded.sameDayLockoutMinutes) patch.sameDayLockoutMinutes = lk;
    if (gr !== loaded.gracePeriodDays) patch.gracePeriodDays = gr;
    await save(patch, 'mechanics');
  };

  return (
    <SectionShell
      title="כללי כרטיסייה"
      description="כללים המוחלים בזמן ניקוב — נעילה בין ניקובים רצופים ותקופת חסד שמאפשרת כניסה גם לאחר תאריך פג תוקף. הקופאי בוחר בעצמו כמה כניסות לנקב בכל סריקה, עד למספר הכניסות שנותרו בכרטיסייה."
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
        <NumberField
          label="נעילה בין ניקובים"
          value={lockout}
          onChange={setLockout}
          disabled={submitting}
          suffix="דקות"
          hint="0 = אין נעילה."
        />
        <NumberField
          label="תקופת חסד לאחר תוקף"
          value={grace}
          onChange={setGrace}
          disabled={submitting}
          suffix="ימים"
          hint="0 = פג תוקף קשה. בתקופת חסד יוצג באנר אזהרה."
        />
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Cancellation — toggles + refund policy + role
// ---------------------------------------------------------------------------

function CancelSection({
  loaded,
  onSaved,
  reload,
}: {
  loaded: CardSettings;
  onSaved: (next: CardSettings) => void;
  reload: () => Promise<void>;
}) {
  const [allowAfter, setAllowAfter] = useState(loaded.allowCancelAfterFirstPunch);
  const [minLen, setMinLen] = useState(String(loaded.minCancelReasonLength));
  const [policy, setPolicy] = useState(loaded.refundPolicyText);
  const [role, setRole] = useState<CancelRole>(loaded.cancelRole);
  const { submitting, error, flash, save } = useSectionSave(onSaved, reload);

  useEffect(() => {
    setAllowAfter(loaded.allowCancelAfterFirstPunch);
    setMinLen(String(loaded.minCancelReasonLength));
    setPolicy(loaded.refundPolicyText);
    setRole(loaded.cancelRole);
  }, [loaded]);

  const dirty =
    allowAfter !== loaded.allowCancelAfterFirstPunch ||
    minLen !== String(loaded.minCancelReasonLength) ||
    policy !== loaded.refundPolicyText ||
    role !== loaded.cancelRole;

  const submit = async () => {
    const patch: CardSettingsPatch = {};
    const ml = Number(minLen);
    if (!Number.isInteger(ml)) return;
    if (allowAfter !== loaded.allowCancelAfterFirstPunch) patch.allowCancelAfterFirstPunch = allowAfter;
    if (ml !== loaded.minCancelReasonLength) patch.minCancelReasonLength = ml;
    if (policy !== loaded.refundPolicyText) patch.refundPolicyText = policy;
    if (role !== loaded.cancelRole) patch.cancelRole = role;
    await save(patch, 'cancel');
  };

  return (
    <SectionShell
      title="ביטולים והחזרים"
      description="מי רשאי לבטל, האם מותר לבטל לאחר ניקוב ראשון, ומה הטקסט שיוצג בחלון הביטול."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <BooleanField
          label="התרת ביטול לאחר ניקוב ראשון"
          description="כשמכובה, לא ניתן לבטל כרטיסייה שכבר נוצב בה לפחות פעם אחת."
          checked={allowAfter}
          onChange={setAllowAfter}
          disabled={submitting}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
          <NumberField
            label="אורך מינימלי לסיבת ביטול"
            value={minLen}
            onChange={setMinLen}
            disabled={submitting}
            suffix="תווים"
            hint="הקופאי חייב לכתוב לפחות N תווים."
          />
          <SelectField<CancelRole>
            label="הרשאת ביטול"
            value={role}
            onChange={setRole}
            disabled={submitting}
            hint="מי רשאי ללחוץ על 'בטל' בכרטיסייה."
            options={[
              { value: 'manager', label: 'אדמין + מנהל משמרת' },
              { value: 'admin', label: 'אדמין בלבד' },
            ]}
          />
        </div>
        <TextAreaField
          label="טקסט מדיניות החזרים"
          value={policy}
          onChange={setPolicy}
          disabled={submitting}
          hint="נראה לקופאי בחלון הביטול — לקריאה ללקוח לפני שמאשרים."
          maxLength={2000}
          rows={5}
        />
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// SMS — purchase, low entries, quiet hours
// ---------------------------------------------------------------------------

function SmsSection({
  loaded,
  onSaved,
  reload,
}: {
  loaded: CardSettings;
  onSaved: (next: CardSettings) => void;
  reload: () => Promise<void>;
}) {
  const [onPurchase, setOnPurchase] = useState(loaded.smsOnPurchase);
  const [emailOnPurchase, setEmailOnPurchase] = useState(loaded.emailOnPurchase);
  const [lowThreshold, setLowThreshold] = useState(String(loaded.smsLowEntriesThreshold));
  const [quietStart, setQuietStart] = useState(formatHHMM(loaded.smsQuietStartMinutes));
  const [quietEnd, setQuietEnd] = useState(formatHHMM(loaded.smsQuietEndMinutes));
  const [quietError, setQuietError] = useState<string | null>(null);
  const { submitting, error, flash, save } = useSectionSave(onSaved, reload);

  useEffect(() => {
    setOnPurchase(loaded.smsOnPurchase);
    setEmailOnPurchase(loaded.emailOnPurchase);
    setLowThreshold(String(loaded.smsLowEntriesThreshold));
    setQuietStart(formatHHMM(loaded.smsQuietStartMinutes));
    setQuietEnd(formatHHMM(loaded.smsQuietEndMinutes));
  }, [loaded]);

  const dirty =
    onPurchase !== loaded.smsOnPurchase ||
    emailOnPurchase !== loaded.emailOnPurchase ||
    lowThreshold !== String(loaded.smsLowEntriesThreshold) ||
    quietStart !== formatHHMM(loaded.smsQuietStartMinutes) ||
    quietEnd !== formatHHMM(loaded.smsQuietEndMinutes);

  const submit = async () => {
    const patch: CardSettingsPatch = {};
    const lt = Number(lowThreshold);
    if (!Number.isInteger(lt)) return;
    const qs = parseHHMM(quietStart);
    const qe = parseHHMM(quietEnd);
    if (qs === undefined || qe === undefined) {
      setQuietError('שעות שקט חייבות להיות בפורמט HH:MM (לדוגמה 21:00).');
      return;
    }
    setQuietError(null);
    if (onPurchase !== loaded.smsOnPurchase) patch.smsOnPurchase = onPurchase;
    if (emailOnPurchase !== loaded.emailOnPurchase) patch.emailOnPurchase = emailOnPurchase;
    if (lt !== loaded.smsLowEntriesThreshold) patch.smsLowEntriesThreshold = lt;
    if (qs !== loaded.smsQuietStartMinutes) patch.smsQuietStartMinutes = qs;
    if (qe !== loaded.smsQuietEndMinutes) patch.smsQuietEndMinutes = qe;
    await save(patch, 'sms');
  };

  return (
    <SectionShell
      title="הודעות לאחר רכישה"
      description="לאחר יצירת כרטיסייה חדשה (בקופה או באתר) הלקוח מקבל הודעה עם קישור לאזור האישי. הודעות OTP לא מושפעות מההגדרות כאן."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <BooleanField
          label="שליחת SMS למכירת כרטיסייה"
          description="לקוח יקבל SMS לאחר רכישת כרטיסייה חדשה עם המספר הסידורי, התוקף וקישור לאזור האישי."
          checked={onPurchase}
          onChange={setOnPurchase}
          disabled={submitting}
        />
        <BooleanField
          label="שליחת אימייל למכירת כרטיסייה"
          description="לקוח עם כתובת מייל יקבל בנוסף ל-SMS גם אימייל מעוצב עם פרטי הכרטיסייה וקישור לאזור האישי. נשלח רק כאשר ללקוח יש מייל בקובץ."
          checked={emailOnPurchase}
          onChange={setEmailOnPurchase}
          disabled={submitting}
        />
        <NumberField
          label="סף הודעה לכניסות נמוכות"
          value={lowThreshold}
          onChange={setLowThreshold}
          disabled={submitting}
          suffix="כניסות"
          hint="0 = ביטול. אם נותרו N כניסות או פחות לאחר ניקוב, הלקוח יקבל הודעה (אם נתן הסכמה)."
        />
        <div style={{ fontSize: 13.5, color: MUTED, fontWeight: 600, marginTop: 4 }}>שעות שקט</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 14 }}>
          <TextField
            label="מהשעה"
            value={quietStart}
            onChange={setQuietStart}
            disabled={submitting}
            hint="פורמט HH:MM"
            maxLength={5}
          />
          <TextField
            label="עד השעה"
            value={quietEnd}
            onChange={setQuietEnd}
            disabled={submitting}
            hint="פורמט HH:MM"
            maxLength={5}
          />
        </div>
        {quietError && (
          <div style={{ fontSize: 13, color: '#a23a3a' }} role="alert">
            {quietError}
          </div>
        )}
        <div style={{ fontSize: 12.5, color: MUTED, fontStyle: 'italic' }}>
          בתוך החלון לא נשלחות הודעות שיווקיות. חלון שעובר חצות מתאפשר (למשל 21:00 → 09:00).
          הערה: היום הודעות שנופלות בשעות שקט נדחות ולא נשלחות בכלל; תזמון מאוחר יבוא כשהתשתית למשימות מתוזמנות תתווסף.
        </div>
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Operations — expiry badge + customer registration rules
// ---------------------------------------------------------------------------

function OperationsSection({
  loaded,
  onSaved,
  reload,
}: {
  loaded: CardSettings;
  onSaved: (next: CardSettings) => void;
  reload: () => Promise<void>;
}) {
  const [badge, setBadge] = useState(String(loaded.expiryBadgeThresholdDays));
  const [requireEmail, setRequireEmail] = useState(loaded.requireEmailOnNewCustomer);
  const [requireChild, setRequireChild] = useState(loaded.requireChildOnNewCustomer);
  const { submitting, error, flash, save } = useSectionSave(onSaved, reload);

  useEffect(() => {
    setBadge(String(loaded.expiryBadgeThresholdDays));
    setRequireEmail(loaded.requireEmailOnNewCustomer);
    setRequireChild(loaded.requireChildOnNewCustomer);
  }, [loaded]);

  const dirty =
    badge !== String(loaded.expiryBadgeThresholdDays) ||
    requireEmail !== loaded.requireEmailOnNewCustomer ||
    requireChild !== loaded.requireChildOnNewCustomer;

  const submit = async () => {
    const patch: CardSettingsPatch = {};
    const b = Number(badge);
    if (!Number.isInteger(b)) return;
    if (b !== loaded.expiryBadgeThresholdDays) patch.expiryBadgeThresholdDays = b;
    if (requireEmail !== loaded.requireEmailOnNewCustomer)
      patch.requireEmailOnNewCustomer = requireEmail;
    if (requireChild !== loaded.requireChildOnNewCustomer)
      patch.requireChildOnNewCustomer = requireChild;
    await save(patch, 'operations');
  };

  return (
    <SectionShell
      title="חוויית קופה ולקוחות"
      description="הגדרות חזותיות וכללי רישום לקוחות חדשים."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <NumberField
          label="סף תג 'פג בקרוב'"
          value={badge}
          onChange={setBadge}
          disabled={submitting}
          suffix="ימים"
          hint="0 = ביטול. כשהכרטיסייה הפעילה תפוג תוך N ימים יוצג תג צהוב במסך הלקוח ובסריקה."
        />
        <div style={{ fontSize: 13.5, color: MUTED, fontWeight: 600, marginTop: 4 }}>
          רישום לקוחות חדשים
        </div>
        <BooleanField
          label="מייל חובה"
          description="כשמופעל, שדה המייל בטופס לקוח חדש הופך לחובה (כיום מומלץ בלבד)."
          checked={requireEmail}
          onChange={setRequireEmail}
          disabled={submitting}
        />
        <BooleanField
          label="ילד אחד לפחות חובה"
          description="כשמופעל, חובה להוסיף לפחות שורת ילד אחת בטופס לקוח חדש."
          checked={requireChild}
          onChange={setRequireChild}
          disabled={submitting}
        />
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// POS controls + editable customer-facing copy (Yanay 2026-06-20)
// Anti-fraud knobs (receipt number, cashier PIN) + the four customer-facing
// strings Yanay can edit (POS checkbox label, email nudge, email OTP
// subject + body template).
// ---------------------------------------------------------------------------

function PosControlsSection({
  loaded,
  onSaved,
  reload,
}: {
  loaded: CardSettings;
  onSaved: (next: CardSettings) => void;
  reload: () => Promise<void>;
}) {
  const [requireReceipt, setRequireReceipt] = useState(loaded.requireReceiptNumberOnPos);
  const [requirePin, setRequirePin] = useState(loaded.requireSellerPin);
  const [pinLength, setPinLength] = useState(String(loaded.pinLength));
  const [pinMemory, setPinMemory] = useState(String(loaded.pinMemoryMinutes));
  const [pinMaxFail, setPinMaxFail] = useState(String(loaded.pinMaxFailures));
  const [pinLockout, setPinLockout] = useState(String(loaded.pinLockoutMinutes));
  const [nameLabel, setNameLabel] = useState(loaded.posNameOnReceiptLabel);
  const [emailNudge, setEmailNudge] = useState(loaded.posEmailNudgeText);
  const [otpSubject, setOtpSubject] = useState(loaded.emailOtpSubject);
  const [otpBody, setOtpBody] = useState(loaded.emailOtpBodyTemplate);
  const { submitting, error, flash, save } = useSectionSave(onSaved, reload);

  useEffect(() => {
    setRequireReceipt(loaded.requireReceiptNumberOnPos);
    setRequirePin(loaded.requireSellerPin);
    setPinLength(String(loaded.pinLength));
    setPinMemory(String(loaded.pinMemoryMinutes));
    setPinMaxFail(String(loaded.pinMaxFailures));
    setPinLockout(String(loaded.pinLockoutMinutes));
    setNameLabel(loaded.posNameOnReceiptLabel);
    setEmailNudge(loaded.posEmailNudgeText);
    setOtpSubject(loaded.emailOtpSubject);
    setOtpBody(loaded.emailOtpBodyTemplate);
  }, [loaded]);

  const dirty =
    requireReceipt !== loaded.requireReceiptNumberOnPos ||
    requirePin !== loaded.requireSellerPin ||
    pinLength !== String(loaded.pinLength) ||
    pinMemory !== String(loaded.pinMemoryMinutes) ||
    pinMaxFail !== String(loaded.pinMaxFailures) ||
    pinLockout !== String(loaded.pinLockoutMinutes) ||
    nameLabel !== loaded.posNameOnReceiptLabel ||
    emailNudge !== loaded.posEmailNudgeText ||
    otpSubject !== loaded.emailOtpSubject ||
    otpBody !== loaded.emailOtpBodyTemplate;

  const submit = async () => {
    const patch: CardSettingsPatch = {};
    const len = Number(pinLength);
    const mem = Number(pinMemory);
    const mx = Number(pinMaxFail);
    const lk = Number(pinLockout);
    if ([len, mem, mx, lk].some((n) => !Number.isInteger(n))) return;
    if (requireReceipt !== loaded.requireReceiptNumberOnPos)
      patch.requireReceiptNumberOnPos = requireReceipt;
    if (requirePin !== loaded.requireSellerPin) patch.requireSellerPin = requirePin;
    if (len !== loaded.pinLength) patch.pinLength = len;
    if (mem !== loaded.pinMemoryMinutes) patch.pinMemoryMinutes = mem;
    if (mx !== loaded.pinMaxFailures) patch.pinMaxFailures = mx;
    if (lk !== loaded.pinLockoutMinutes) patch.pinLockoutMinutes = lk;
    if (nameLabel.trim() !== loaded.posNameOnReceiptLabel)
      patch.posNameOnReceiptLabel = nameLabel.trim();
    if (emailNudge.trim() !== loaded.posEmailNudgeText)
      patch.posEmailNudgeText = emailNudge.trim();
    if (otpSubject.trim() !== loaded.emailOtpSubject) patch.emailOtpSubject = otpSubject.trim();
    // Body template is sent raw — newlines and leading whitespace are
    // intentional content.
    if (otpBody !== loaded.emailOtpBodyTemplate) patch.emailOtpBodyTemplate = otpBody;
    await save(patch, 'pos-controls');
  };

  return (
    <SectionShell
      title="קופה ובקרה"
      description="כלי בקרה למניעת הנפקת כרטיסיות ללא תיעוד בקופה, וטקסטים שמופיעים ללקוחות שניתן לערוך כאן."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <BooleanField
          label="חובה למלא מספר קבלה"
          description="כשמופעל, בכל מכירה בקופה הקופאי חייב להזין את מספר הקבלה שהדפיס במכשיר. השרת מונע שכפול של אותו מספר על שתי כרטיסיות."
          checked={requireReceipt}
          onChange={setRequireReceipt}
          disabled={submitting}
        />
        <BooleanField
          label="חובה להזין קוד אישי בכל מכירה"
          description="כשמופעל, בכל מכירה מופיע חלון לקוד האישי של הקופאי. הקוד נזכר באותו דפדפן למשך זמן הזיכרון שמוגדר למטה כדי שלא יישאל שוב ושוב."
          checked={requirePin}
          onChange={setRequirePin}
          disabled={submitting}
        />
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 14 }}
        >
          <NumberField
            label="אורך הקוד האישי"
            value={pinLength}
            onChange={setPinLength}
            disabled={submitting}
            suffix="ספרות"
            hint="3–12. ערך נמוך עדיף לקופה מהירה, גבוה לבטיחות יתרה."
          />
          <NumberField
            label="זיכרון הקוד בדפדפן"
            value={pinMemory}
            onChange={setPinMemory}
            disabled={submitting}
            suffix="דקות"
            hint="באותו דפדפן הקוד יישאל רק פעם בכל חלון זמן. ניתן לאפס בלחיצה על 'החלף קופאי'."
          />
          <NumberField
            label="ניסיונות מותרים לפני נעילה"
            value={pinMaxFail}
            onChange={setPinMaxFail}
            disabled={submitting}
            suffix="ניסיונות"
            hint="לאחר כל כך הרבה ניסיונות שגויים הקוד יינעל. מנהל יכול לשחרר ידנית."
          />
          <NumberField
            label="משך נעילה"
            value={pinLockout}
            onChange={setPinLockout}
            disabled={submitting}
            suffix="דקות"
            hint="לאחר נעילה הקוד מושבת לכמות דקות זו, אלא אם מנהל ישחרר."
          />
        </div>

        <div style={{ fontSize: 13.5, color: MUTED, fontWeight: 600, marginTop: 8 }}>
          טקסטים שמופיעים ללקוחות
        </div>
        <TextField
          label="טקסט וי שם הלקוח (קופה)"
          value={nameLabel}
          onChange={setNameLabel}
          disabled={submitting}
          hint="המשפט שמופיע על תיבת הסימון 'רשמתי את שם הלקוח על הקבלה' לפני שמאשרים מכירה."
          maxLength={200}
        />
        <TextAreaField
          label="טקסט עידוד למילוי אימייל (קופה)"
          value={emailNudge}
          onChange={setEmailNudge}
          disabled={submitting}
          hint="ההסבר הקצר מתחת לשדה האימייל בטופס לקוח חדש."
          maxLength={500}
          rows={3}
        />
        <TextField
          label="נושא של מייל OTP"
          value={otpSubject}
          onChange={setOtpSubject}
          disabled={submitting}
          hint="הנושא שייראה בתיבת הדואר של הלקוח שמתחבר באימייל."
          maxLength={200}
        />
        <TextAreaField
          label="תוכן של מייל OTP"
          value={otpBody}
          onChange={setOtpBody}
          disabled={submitting}
          hint={'הגוף של המייל. ניתן להשתמש בתווי מיקום {{firstName}} ו-{{code}}. כל תו מיקום אחר ייגרום לשגיאה בשמירה.'}
          maxLength={2000}
          rows={8}
        />
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// "Thank you" page after a WC checkout (my.memesh.co.il/checkout-complete).
// Three editable strings — title, body, button text. The {{firstName}}
// placeholder is substituted server-side; unknown placeholders are rejected
// by the API at save time so a typo can't silently break the page.
// ---------------------------------------------------------------------------
function ThankyouSection({
  loaded,
  onSaved,
  reload,
}: {
  loaded: CardSettings;
  onSaved: (next: CardSettings) => void;
  reload: () => Promise<void>;
}) {
  const [title, setTitle] = useState(loaded.checkoutThankyouTitle);
  const [body, setBody] = useState(loaded.checkoutThankyouBody);
  const [buttonText, setButtonText] = useState(loaded.checkoutThankyouButtonText);
  const { submitting, error, flash, save } = useSectionSave(onSaved, reload);

  useEffect(() => {
    setTitle(loaded.checkoutThankyouTitle);
    setBody(loaded.checkoutThankyouBody);
    setButtonText(loaded.checkoutThankyouButtonText);
  }, [loaded]);

  const dirty =
    title !== loaded.checkoutThankyouTitle ||
    body !== loaded.checkoutThankyouBody ||
    buttonText !== loaded.checkoutThankyouButtonText;

  const submit = async () => {
    const patch: CardSettingsPatch = {};
    if (title.trim() !== loaded.checkoutThankyouTitle)
      patch.checkoutThankyouTitle = title.trim();
    if (body.trim() !== loaded.checkoutThankyouBody) patch.checkoutThankyouBody = body.trim();
    if (buttonText.trim() !== loaded.checkoutThankyouButtonText)
      patch.checkoutThankyouButtonText = buttonText.trim();
    await save(patch, 'thankyou');
  };

  return (
    <SectionShell
      title="דף תודה לאחר רכישה"
      description='הטקסטים שמופיעים על דף "תודה" באזור האישי (my.memesh.co.il) מיד אחרי שלקוח רוכש כרטיסייה באתר. ניתן להשתמש בתו המיקום {{firstName}} שייוחלף בשם הפרטי של הלקוח (במידה שאין שם — יוחלף ל"לקוח/ה").'
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TextField
          label="כותרת ראשית"
          value={title}
          onChange={setTitle}
          disabled={submitting}
          hint='הכותרת הגדולה שמופיעה בראש הכרטיס. דוגמה: "תודה רבה, {{firstName}}! 🎉"'
          maxLength={120}
        />
        <TextAreaField
          label="טקסט גוף"
          value={body}
          onChange={setBody}
          disabled={submitting}
          hint="המשפט שמופיע מתחת לכותרת. שני שורות כדי להישאר נעים ונקי."
          maxLength={400}
          rows={3}
        />
        <TextField
          label="טקסט הכפתור"
          value={buttonText}
          onChange={setButtonText}
          disabled={submitting}
          hint='הטקסט על הכפתור הראשי שמוביל לאזור האישי. למשל: "לאזור האישי שלי".'
          maxLength={60}
        />
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}
