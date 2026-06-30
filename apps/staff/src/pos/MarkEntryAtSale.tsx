import { type CSSProperties, useState } from 'react';

// Post-sale prompt that runs AFTER POST /cards succeeds and BEFORE the QR
// success step. The cashier picks one of four explicit actions — none of
// them pre-selected — so the dominant "buy + walk in" case collapses to a
// single tap instead of a second scan-and-punch a minute later. Skipping
// (no entries now) is a first-class option so gift purchases never
// silently consume an entry.
//
// Design constraints (set by Yoav, 2026-06-25):
//   - No default. The four tiles are visually equal weight; nothing is
//     pre-highlighted. The cashier must actively pick before anything
//     happens. See _plans/2026-06-25-pos-sell-mark-entry-prompt.md.
//   - "Custom" reveals a +/- picker clamped to [1, totalEntries]. Quick
//     picks (1, 2) cover the realistic same-visit cases (child +
//     companion). Anything beyond goes through Custom.
//   - The parent owns the punch call + idempotency key. This component is
//     pure UI: it dispatches the chosen count and renders error/loading
//     based on the parent's state.

const ORANGE = '#ffa983';
const INK = '#2d3436';
const MUTED = '#636e72';

const card: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
  padding: 20,
};

const tileBase: CSSProperties = {
  background: '#fff',
  color: INK,
  border: '1.5px solid #e9e0d9',
  borderRadius: 12,
  fontWeight: 600,
  fontSize: 16,
  padding: '18px 12px',
  cursor: 'pointer',
  minHeight: 72,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
};

const tileBusy: CSSProperties = {
  ...tileBase,
  background: '#fff8f3',
  borderColor: ORANGE,
  color: ORANGE,
  cursor: 'wait',
};

const tileDisabled: CSSProperties = {
  ...tileBase,
  opacity: 0.5,
  cursor: 'not-allowed',
};

const stepBtnStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 12,
  border: '1.5px solid #e9e0d9',
  background: '#fff',
  fontSize: 22,
  color: INK,
  cursor: 'pointer',
};

const primaryBtn: CSSProperties = {
  background: ORANGE,
  color: '#fff',
  border: 'none',
  borderRadius: 10,
  fontWeight: 600,
  padding: '14px 28px',
  fontSize: 16,
  cursor: 'pointer',
};

const ghostBtn: CSSProperties = {
  background: '#fff',
  color: MUTED,
  border: '1.5px solid #e9e0d9',
  borderRadius: 10,
  fontWeight: 600,
  padding: '12px 18px',
  fontSize: 15,
  cursor: 'pointer',
};

const entriesLabel = (n: number): string => (n === 1 ? 'כניסה אחת' : `${n} כניסות`);

// Which tile (if any) is currently active. Initial state is `null` — the
// caller cannot infer a chosen count from the UI; that's the "no default"
// requirement made testable.
export type MarkEntryTile = 'skip' | 1 | 2 | 'custom';

interface Props {
  /** Card serial — shown small so the cashier can sanity-check which card
   *  the prompt is for if they were juggling two screens. */
  serial: string;
  /** Upper bound for the custom picker (the card's totalEntries). The
   *  parent passes the live value from the sell response. */
  maxEntries: number;
  /** Which tile the cashier picked. The parent owns this so it can keep
   *  the same tile visually marked through the network call. `null` means
   *  no choice yet — the explicit no-default state. */
  busyTile: MarkEntryTile | null;
  /** True while the parent is awaiting POST /punch. Tiles other than the
   *  busy one go disabled to prevent a parallel second choice. */
  submitting: boolean;
  /** Server error code mapped to Hebrew by the parent. Renders as a red
   *  banner with a "נסה שוב" affordance on the chosen tile. */
  error: string | null;
  /** Skip: do not punch, just advance to the QR success screen. */
  onSkip: () => void;
  /** Punch N entries now and then advance. */
  onConfirm: (entries: number) => void;
}

/**
 * Picks the chosen quick-tile back to the parent and renders the custom
 * picker inline. Owns only the custom-picker substate (open + amount); the
 * "which tile is busy / has errored" state lives on the parent so it
 * survives across re-renders triggered by the network call.
 */
export function MarkEntryAtSale({
  serial,
  maxEntries,
  busyTile,
  submitting,
  error,
  onSkip,
  onConfirm,
}: Props) {
  // Custom-picker substate. customAmount is only meaningful when
  // customOpen is true. Clamp to [1, maxEntries] on every tick so an
  // out-of-range maxEntries (smaller than current) self-corrects.
  const [customOpen, setCustomOpen] = useState(false);
  const [customAmount, setCustomAmount] = useState(1);
  const ceiling = Math.max(1, maxEntries);
  const safeCustom = Math.min(ceiling, Math.max(1, customAmount));

  const tileStyle = (tile: MarkEntryTile): CSSProperties => {
    if (busyTile === tile && submitting) return tileBusy;
    if (submitting) return tileDisabled;
    return tileBase;
  };

  const pickQuick = (entries: 1 | 2): void => {
    if (submitting) return;
    setCustomOpen(false);
    onConfirm(entries);
  };

  const pickCustom = (): void => {
    if (submitting) return;
    setCustomOpen(true);
  };

  const confirmCustom = (): void => {
    if (submitting) return;
    onConfirm(safeCustom);
  };

  const pickSkip = (): void => {
    if (submitting) return;
    setCustomOpen(false);
    onSkip();
  };

  return (
    <div style={card}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>כניסה עכשיו?</div>
      <div style={{ color: MUTED, fontSize: 14, marginTop: 6 }}>
        בחרו כמה כניסות לנקב כעת, או דלגו אם הלקוח עדיין לא נכנס/ת.
      </div>

      <div style={{ fontSize: 12.5, color: MUTED, marginTop: 8 }}>{serial}</div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          marginTop: 16,
        }}
      >
        <button
          type="button"
          style={tileStyle('skip')}
          onClick={pickSkip}
          disabled={submitting}
          data-tile="skip"
        >
          <span>בלי כניסה כעת</span>
          <span style={{ fontSize: 12, color: MUTED, fontWeight: 400 }}>
            לניקוב בהמשך מהסריקה
          </span>
        </button>
        <button
          type="button"
          style={tileStyle(1)}
          onClick={() => pickQuick(1)}
          disabled={submitting}
          data-tile="1"
        >
          <span style={{ fontSize: 28, color: ORANGE }}>1</span>
          <span style={{ fontSize: 13, color: MUTED, fontWeight: 400 }}>כניסה אחת</span>
        </button>
        <button
          type="button"
          style={tileStyle(2)}
          onClick={() => pickQuick(2)}
          disabled={submitting || ceiling < 2}
          data-tile="2"
        >
          <span style={{ fontSize: 28, color: ORANGE }}>2</span>
          <span style={{ fontSize: 13, color: MUTED, fontWeight: 400 }}>שתי כניסות</span>
        </button>
        <button
          type="button"
          style={tileStyle('custom')}
          onClick={pickCustom}
          disabled={submitting}
          data-tile="custom"
        >
          <span>כמות אחרת</span>
          <span style={{ fontSize: 12, color: MUTED, fontWeight: 400 }}>
            מ-1 עד {ceiling}
          </span>
        </button>
      </div>

      {customOpen && (
        <div
          style={{
            marginTop: 16,
            padding: '14px 14px 16px',
            background: '#fff8f3',
            border: '1px solid #ffe3d4',
            borderRadius: 12,
          }}
        >
          <div style={{ fontSize: 14, color: MUTED, textAlign: 'center' }}>
            כמה כניסות לסמן עכשיו?
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 16,
              marginTop: 10,
            }}
          >
            <button
              type="button"
              style={stepBtnStyle}
              onClick={() => setCustomAmount((n) => Math.max(1, n - 1))}
              disabled={submitting || safeCustom <= 1}
              aria-label="פחות כניסות"
            >
              −
            </button>
            <div style={{ minWidth: 64, textAlign: 'center' }}>
              <div style={{ fontSize: 36, fontWeight: 600, color: ORANGE, lineHeight: 1 }}>
                {safeCustom}
              </div>
              <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>
                {entriesLabel(safeCustom)}
              </div>
            </div>
            <button
              type="button"
              style={stepBtnStyle}
              onClick={() => setCustomAmount((n) => Math.min(ceiling, n + 1))}
              disabled={submitting || safeCustom >= ceiling}
              aria-label="עוד כניסות"
            >
              +
            </button>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button
              type="button"
              style={{ ...ghostBtn, flex: 1 }}
              onClick={() => setCustomOpen(false)}
              disabled={submitting}
            >
              חזרה לבחירה
            </button>
            <button
              type="button"
              style={{ ...primaryBtn, flex: 1, opacity: submitting ? 0.7 : 1 }}
              onClick={confirmCustom}
              disabled={submitting}
            >
              {submitting && busyTile === 'custom' ? 'מסמן…' : `סמן ${entriesLabel(safeCustom)}`}
            </button>
          </div>
        </div>
      )}

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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so the test file can exercise them without
// instantiating the component (the staff test runner is `node --test` with
// no React renderer wired). Keep the logic the tests pin in here.
// ---------------------------------------------------------------------------

/**
 * Clamp a custom-amount value into the picker's valid range. The component
 * uses this on every render; pulling it out lets the test pin the behavior
 * even when no React tree exists.
 */
export function clampCustomAmount(value: number, maxEntries: number): number {
  const ceiling = Math.max(1, maxEntries);
  if (!Number.isFinite(value)) return 1;
  if (value < 1) return 1;
  if (value > ceiling) return ceiling;
  return Math.trunc(value);
}

/**
 * Translate the chosen tile + (for 'custom') the picker amount into the
 * entries integer the punch endpoint should consume. Returns 0 for the
 * skip case so callers can branch on a single number. The custom path
 * goes through clampCustomAmount so a stale UI value can never exceed
 * the card ceiling.
 */
export function entriesForTile(
  tile: MarkEntryTile,
  customAmount: number,
  maxEntries: number,
): number {
  if (tile === 'skip') return 0;
  if (tile === 1) return 1;
  if (tile === 2) return Math.min(2, Math.max(1, maxEntries));
  return clampCustomAmount(customAmount, maxEntries);
}
