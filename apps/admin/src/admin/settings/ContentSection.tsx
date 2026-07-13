import { CONTENT_GROUPS, CONTENT_REGISTRY, contentEntriesByGroup } from '@memesh/content';
import { useEffect, useMemo, useState } from 'react';
import { getContentOverrides, updateContent } from '../../lib/api/content';
import { card, humanizeSettingsError, MUTED, SaveBar, SectionShell, TextAreaField, TextField } from './shared';

// "תוכן וטקסטים" — Yanay edits UI copy here (Wave 2 plan 2026-07-13). The
// registry (@memesh/content) is the source of truth for which strings exist and
// their defaults; this screen renders a field per entry, pre-filled with the
// override or the default, and saves only what changed. A blank field resets to
// default. Grouped by surface, searchable, since the registry grows large.

function humanizeContentError(code: string): string {
  if (code === 'unknown_key') return 'שדה לא מוכר. רעננו את הדף ונסו שוב.';
  if (code === 'value_too_long') return 'הטקסט ארוך מדי.';
  if (code === 'unknown_placeholder')
    return 'יש בטקסט תו מיקום שאינו מותר לשדה הזה. השתמשו רק בתווי המיקום שמופיעים בהסבר.';
  return humanizeSettingsError(code);
}

export function ContentSection() {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The current field text per key. Absent key → the registry default is shown.
  const [values, setValues] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const effective = (key: string, def: string): string => overrides[key] ?? def;
  const current = (key: string, def: string): string => values[key] ?? effective(key, def);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getContentOverrides();
      if (cancelled) return;
      if (res.ok) {
        setOverrides(res.data.overrides);
        setLoaded(true);
      } else {
        setLoadError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The patch that would be sent: only entries whose field differs from the live
  // value. A field left at (or reset to) the default sends '' — the server drops
  // the override — so we never store an override equal to the default.
  const patch = useMemo(() => {
    const out: Record<string, string> = {};
    for (const e of CONTENT_REGISTRY) {
      const cur = current(e.key, e.default);
      if (cur === effective(e.key, e.default)) continue;
      out[e.key] = cur.trim() === '' || cur === e.default ? '' : cur;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, overrides]);

  const dirty = Object.keys(patch).length > 0;

  if (loadError) {
    return (
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>תוכן וטקסטים</div>
        <div style={{ color: '#a23a3a', fontSize: 14 }}>
          {loadError === 'forbidden' ? 'רק אדמין יכול לפתוח מסך זה.' : 'לא ניתן לטעון. רעננו את הדף.'}
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>תוכן וטקסטים</div>
        <div style={{ color: MUTED, fontSize: 14 }}>טוען…</div>
      </div>
    );
  }

  const q = query.trim();
  const matches = (label: string, def: string, key: string): boolean =>
    q === '' || label.includes(q) || def.includes(q) || key.includes(q);

  const submit = async () => {
    if (!dirty) return;
    setSubmitting(true);
    setError(null);
    const res = await updateContent(patch);
    setSubmitting(false);
    if (!res.ok) {
      // The API returns the structured error object for content-specific codes.
      const code = typeof res.error === 'string' ? res.error : (res.error as { code: string }).code;
      setError(humanizeContentError(code));
      return;
    }
    // Fold the applied patch into local state: '' removed the override, else set it.
    setOverrides((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(patch)) {
        if (value === '') delete next[key];
        else next[key] = value;
      }
      return next;
    });
    setValues({});
    setFlash('הטקסטים נשמרו');
    setTimeout(() => setFlash(null), 2500);
  };

  return (
    <SectionShell
      title="תוכן וטקסטים"
      description="עריכת הטקסטים שהלקוחות והצוות רואים באפליקציה. השאירו שדה ריק כדי לחזור לברירת המחדל. שינוי יופיע ללקוח בטעינה הבאה של הדף."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש טקסט…"
          style={{
            width: '100%',
            fontSize: 14,
            padding: '10px 14px',
            border: '1.5px solid #e9e0d9',
            borderRadius: 10,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />

        {CONTENT_GROUPS.map((group) => {
          const entries = contentEntriesByGroup(group.id).filter((e) =>
            matches(e.label, e.default, e.key),
          );
          if (entries.length === 0) return null;
          return (
            <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{group.label}</div>
              {entries.map((e) => {
                const cur = current(e.key, e.default);
                const isCustom = cur !== e.default;
                const hint = e.help
                  ? `${e.help} ברירת מחדל: ${e.default}`
                  : `ברירת מחדל: ${e.default}`;
                const field =
                  e.kind === 'long' ? (
                    <TextAreaField
                      label={e.label}
                      value={cur}
                      onChange={(v) => setValues((s) => ({ ...s, [e.key]: v }))}
                      disabled={submitting}
                      hint={hint}
                      maxLength={2000}
                    />
                  ) : (
                    <TextField
                      label={e.label}
                      value={cur}
                      onChange={(v) => setValues((s) => ({ ...s, [e.key]: v }))}
                      disabled={submitting}
                      hint={hint}
                      maxLength={200}
                    />
                  );
                return (
                  <div key={e.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {field}
                    {isCustom && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => setValues((s) => ({ ...s, [e.key]: e.default }))}
                        style={{
                          alignSelf: 'flex-start',
                          border: 'none',
                          background: 'transparent',
                          color: MUTED,
                          fontSize: 12,
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                        }}
                      >
                        אפס לברירת מחדל
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}
