import { CONTENT_GROUPS, CONTENT_REGISTRY, contentEntriesByGroup } from '@memesh/content';
import { useEffect, useMemo, useState } from 'react';
import { getContentOverrides, updateContent } from '../../lib/api/content';
import { card, humanizeSettingsError, INK, MUTED, ORANGE, SaveBar, SectionShell, TextAreaField, TextField } from './shared';

// "תוכן וטקסטים" — Yanay edits UI copy here (Wave 2 plan 2026-07-13). The
// registry (@memesh/content) is the source of truth for which strings exist and
// their defaults; this screen renders a field per entry, pre-filled with the
// override or the default, and saves only what changed. A blank field resets to
// default.
//
// Layout: one collapsible accordion per group (collapsed by default so the page
// stays short), each header showing the field count and how many are customised.
// A search box filters across all groups and auto-opens the ones with matches.

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
  const [open, setOpen] = useState<Record<string, boolean>>({});

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
  const searching = q !== '';
  const matches = (label: string, def: string, key: string): boolean =>
    !searching || label.includes(q) || def.includes(q) || key.includes(q);

  const submit = async () => {
    if (!dirty) return;
    setSubmitting(true);
    setError(null);
    const res = await updateContent(patch);
    setSubmitting(false);
    if (!res.ok) {
      const code = typeof res.error === 'string' ? res.error : (res.error as { code: string }).code;
      setError(humanizeContentError(code));
      return;
    }
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
      description="עריכת הטקסטים שהלקוחות רואים באפליקציה. פתחו קטגוריה כדי לערוך. השאירו שדה ריק כדי לחזור לברירת המחדל. שינוי יופיע ללקוח בטעינה הבאה של הדף."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          const customised = entries.filter((e) => current(e.key, e.default) !== e.default).length;
          const isOpen = searching || open[group.id] === true;
          return (
            <div key={group.id} style={{ border: '1px solid #f0eae5', borderRadius: 12, overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setOpen((s) => ({ ...s, [group.id]: !isOpen }))}
                aria-expanded={isOpen}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '13px 16px',
                  border: 'none',
                  background: isOpen ? '#fffaf6' : '#fff',
                  cursor: 'pointer',
                  textAlign: 'inherit',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span
                    aria-hidden
                    style={{
                      color: MUTED,
                      fontSize: 12,
                      transform: isOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform 120ms',
                    }}
                  >
                    ▶
                  </span>
                  <span style={{ fontSize: 14.5, fontWeight: 600, color: INK }}>{group.label}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                  {customised > 0 && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: ORANGE,
                        background: '#fff1e8',
                        borderRadius: 999,
                        padding: '2px 9px',
                      }}
                    >
                      {customised} שונו
                    </span>
                  )}
                  <span style={{ fontSize: 12.5, color: MUTED }}>{entries.length} שדות</span>
                </span>
              </button>

              {isOpen && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                    padding: '14px 16px',
                    borderTop: '1px solid #f3efea',
                  }}
                >
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
              )}
            </div>
          );
        })}
      </div>
      <SaveBar dirty={dirty} submitting={submitting} error={error} flash={flash} onSubmit={submit} />
    </SectionShell>
  );
}
