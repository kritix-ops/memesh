import { type CSSProperties, type ReactNode } from 'react';

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
  width: '100%',
  fontSize: 15,
  padding: '11px 14px',
  border: '1.5px solid #e9e0d9',
  borderRadius: 10,
  background: '#fff',
  outline: 'none',
  boxSizing: 'border-box',
};

export const primaryBtn: CSSProperties = {
  border: 'none',
  background: ORANGE,
  color: '#fff',
  borderRadius: 10,
  padding: '10px 18px',
  fontWeight: 600,
  cursor: 'pointer',
};

// Humanizes server validation errors common across all sections.
export function humanizeSettingsError(code: string): string {
  if (code === 'price_out_of_range') return 'מחיר חייב להיות בין 0 ל-10,000';
  if (code === 'validity_out_of_range') return 'תוקף חייב להיות בין 1 ל-3,650 ימים';
  if (code === 'entries_out_of_range') return 'כניסות חייב להיות בין 1 ל-100';
  if (code === 'pitch_length') return 'טקסט שיווקי חייב לכלול בין תו אחד ל-200 תווים';
  if (code === 'min_companions_out_of_range') return 'מינימום מלווים חייב להיות בין 1 ל-10';
  if (code === 'max_companions_out_of_range') return 'מקסימום מלווים חייב להיות בין 1 ל-10';
  if (code === 'companion_range_invalid') return 'מינימום מלווים חייב להיות ≤ מקסימום מלווים';
  if (code === 'lockout_out_of_range') return 'נעילה חייבת להיות בין 0 ל-1440 דקות';
  if (code === 'grace_out_of_range') return 'תקופת חסד חייבת להיות בין 0 ל-90 ימים';
  if (code === 'cancel_reason_length_out_of_range') return 'אורך מינימלי לסיבת ביטול בין 1 ל-500';
  if (code === 'refund_policy_too_long') return 'טקסט מדיניות החזרים ארוך מ-2,000 תווים';
  if (code === 'cancel_role_invalid') return 'הרשאת ביטול חייבת להיות אדמין או מנהל';
  if (code === 'sms_low_entries_out_of_range') return 'סף כניסות נמוכות חייב להיות בין 0 ל-100';
  if (code === 'sms_quiet_minutes_out_of_range') return 'שעת שקט לא תקינה';
  if (code === 'expiry_badge_out_of_range') return 'סף תג פג בקרוב בין 0 ל-365 ימים';
  if (code === 'no_changes') return 'לא בוצעו שינויים';
  if (code === 'invalid_body') return 'נתונים לא תקינים. בדקו ונסו שוב.';
  if (code === 'forbidden') return 'רק אדמין יכול לערוך הגדרות.';
  return 'לא ניתן לשמור את ההגדרות. נסו שוב בעוד רגע.';
}

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
    <div style={card}>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{title}</div>
      {description && (
        <div style={{ color: MUTED, fontSize: 13.5, marginTop: 4, lineHeight: 1.5 }}>
          {description}
        </div>
      )}
      <div style={{ marginTop: 18 }}>{children}</div>
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  hint,
  disabled,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  disabled?: boolean;
  suffix?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13.5, color: MUTED }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          style={inputStyle}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          type="number"
          inputMode="numeric"
          disabled={disabled}
        />
        {suffix && <span style={{ color: MUTED, fontSize: 13.5, whiteSpace: 'nowrap' }}>{suffix}</span>}
      </div>
      {hint && <span style={{ fontSize: 12.5, color: MUTED }}>{hint}</span>}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  disabled,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13.5, color: MUTED }}>{label}</span>
      <input
        style={inputStyle}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        {...(maxLength !== undefined && { maxLength })}
      />
      {hint && <span style={{ fontSize: 12.5, color: MUTED }}>{hint}</span>}
    </label>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  disabled,
  maxLength,
  rows,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  disabled?: boolean;
  maxLength?: number;
  rows?: number;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13.5, color: MUTED }}>{label}</span>
      <textarea
        style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'inherit' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={rows ?? 4}
        {...(maxLength !== undefined && { maxLength })}
      />
      {hint && <span style={{ fontSize: 12.5, color: MUTED }}>{hint}</span>}
    </label>
  );
}

export function BooleanField({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: '12px 14px',
        border: '1px solid #f3efea',
        borderRadius: 10,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        style={{ marginTop: 3 }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{label}</div>
        {description && (
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2, lineHeight: 1.5 }}>
            {description}
          </div>
        )}
      </div>
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13.5, color: MUTED }}>{label}</span>
      <select
        style={{ ...inputStyle, paddingInlineEnd: 32 }}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span style={{ fontSize: 12.5, color: MUTED }}>{hint}</span>}
    </label>
  );
}

export function SaveBar({
  dirty,
  submitting,
  error,
  flash,
  onSubmit,
}: {
  dirty: boolean;
  submitting: boolean;
  error: string | null;
  flash: string | null;
  onSubmit: () => void;
}) {
  return (
    <>
      {error && (
        <div
          role="alert"
          style={{
            marginTop: 14,
            padding: '10px 14px',
            background: '#fbecec',
            color: '#a23a3a',
            borderRadius: 10,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}
      {flash && (
        <div
          role="status"
          style={{
            marginTop: 14,
            padding: '10px 14px',
            background: '#f0f5e3',
            color: '#6f8f37',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          ✓ {flash}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
        <button
          type="submit"
          disabled={submitting || !dirty}
          onClick={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          style={{
            ...primaryBtn,
            opacity: submitting || !dirty ? 0.5 : 1,
            cursor: submitting || !dirty ? 'default' : 'pointer',
          }}
        >
          {submitting ? 'שומר…' : 'שמור'}
        </button>
      </div>
    </>
  );
}
