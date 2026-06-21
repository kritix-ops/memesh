import type { CSSProperties, ReactNode } from 'react';
import sunMark from './assets/memesh-sun.png';
import wordmarkSrc from './assets/memesh-wordmark.png';
import { GREEN, INK, MUTED, ORANGE } from './tokens';

interface SunProps {
  size?: number;
  ring?: boolean;
  spin?: boolean;
}

// The brand's primary mark: a hollow green ring with 8 outlined peach
// capsule rays. Rebuilt as SVG so it stays crisp at any size and can be
// tinted/animated — visually matches the source PNG (logo/sun.png).
//
// - `ring=true` (default): hollow green ring center, matching the real mark.
// - `ring=false`: solid orange disc — used in tight chrome (Logo header)
//    where a hollow center would look weak at small sizes.
export function Sun({ size = 46, ring = true, spin = false }: SunProps) {
  const cx = size / 2;
  const cy = size / 2;
  const rayW = size * 0.14;
  const rayLen = size * 0.245;
  const orbit = size * 0.345;
  const rayStroke = Math.max(1.6, size * 0.05);
  const ringStroke = Math.max(2.4, size * 0.075);
  const ringR = size * 0.17;

  const rays = Array.from({ length: 8 }, (_, i) => (
    <rect
      key={i}
      x={cx - rayW / 2}
      y={cy - orbit - rayLen}
      width={rayW}
      height={rayLen}
      rx={rayW / 2}
      fill="none"
      stroke={ORANGE}
      strokeWidth={rayStroke}
      transform={`rotate(${i * 45} ${cx} ${cy})`}
      style={
        spin
          ? { animation: `memesh-ray 1.1s ease-in-out ${i * 0.12}s infinite` }
          : undefined
      }
    />
  ));

  const center = ring ? (
    <circle cx={cx} cy={cy} r={ringR} fill="none" stroke={GREEN} strokeWidth={ringStroke} />
  ) : (
    <circle cx={cx} cy={cy} r={ringR + ringStroke / 2} fill={ORANGE} />
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="ממש"
      style={spin ? { animation: 'memesh-spin 6s linear infinite' } : undefined}
    >
      {rays}
      {center}
    </svg>
  );
}

interface PebbleProps {
  size?: number;
  filled?: boolean;
  color?: string;
}

// The niqqud "pebble": a rounded square, filled or hollow (2px stroke).
export function Pebble({ size = 34, filled = false, color = ORANGE }: PebbleProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: size * 0.32,
    background: filled ? color : 'transparent',
    border: filled ? 'none' : `2px solid ${color}`,
    flexShrink: 0,
  };
  return <div style={style} />;
}

interface PunchCardProps {
  used: number;
  total?: number;
  compact?: boolean;
}

// The signature element: remaining count + a grid of pebbles (filled = used).
export function PunchCard({ used, total = 12, compact = false }: PunchCardProps) {
  const remaining = total - used;
  const numSize = compact ? 46 : 52;
  const pebSize = compact ? 28 : 34;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 18 : 22,
        alignItems: 'center',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8 }}>
          <span style={{ fontSize: numSize, fontWeight: 600, color: ORANGE, lineHeight: 1 }}>
            {remaining}
          </span>
          <span style={{ fontSize: 18, color: MUTED }}>מתוך {total}</span>
        </div>
        <div style={{ fontSize: 14, color: MUTED, marginTop: 4 }}>כניסות שנותרו</div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: compact ? 10 : 12,
          justifyItems: 'center',
        }}
      >
        {Array.from({ length: total }, (_, i) => (
          <Pebble key={i} size={pebSize} filled={i < used} />
        ))}
      </div>
      </div>
  );
}

interface LogoProps {
  // Rendered height of the wordmark in CSS pixels. Width follows the natural
  // aspect ratio of the source asset (≈2.85:1), so the wordmark never stretches.
  height?: number;
}

// The full Memesh wordmark — renders the real brand asset (logo/memeshnoback.png)
// so the typography and niqqud pebbles look exactly as the brand owner drew
// them. We don't redraw the lettering in SVG: the source is a custom mark, not
// a font, and substituting a Google font would degrade it.
//
// Width is derived from the natural 1201×421 aspect of the asset; the consumer
// sets `height` and the wordmark scales cleanly. The default sizes the "מֶמֶש"
// letters at ~26px tall — matching the optical weight of the previous
// synthesized logo so existing header layouts continue to feel balanced.
export function Logo({ height = 48 }: LogoProps) {
  const aspect = 1201 / 421;
  const width = Math.round(height * aspect);
  return (
    <img
      src={wordmarkSrc}
      alt="ממש — משחקיה, בית, קהילה"
      width={width}
      height={height}
      style={{ display: 'block', flexShrink: 0 }}
    />
  );
}

// URL of the standalone sun mark PNG. Exported so apps that need it outside
// React (e.g. for an Open Graph image or a download link) can reach it.
export const sunMarkSrc = sunMark;
export const wordmarkAssetSrc = wordmarkSrc;

/**
 * @deprecated Use `MemeshQr` (exported from `@memesh/brand`) for any card
 * UI a customer or cashier actually interacts with. `FauxQr` is a
 * decorative placeholder that cannot be decoded by a scanner — it exists
 * only for mock screens and design previews.
 */
export function FauxQr({ seed, size = 118 }: { seed: string; size?: number }) {
  const n = 21;
  const m = size / n;
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const inFinder = (x: number, y: number): boolean => {
    const f = (ox: number, oy: number) => x >= ox && x < ox + 7 && y >= oy && y < oy + 7;
    return f(0, 0) || f(n - 7, 0) || f(0, n - 7);
  };
  const cells: ReactNode[] = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (inFinder(x, y)) continue;
      const v = ((x * 73856093) ^ (y * 19349663) ^ h) >>> 0;
      if (v % 100 < 46) {
        cells.push(
          <rect
            key={`${x}-${y}`}
            x={x * m}
            y={y * m}
            width={m + 0.5}
            height={m + 0.5}
            fill={INK}
          />,
        );
      }
    }
  }
  const finder = (ox: number, oy: number, k: string): ReactNode[] => [
    <rect
      key={`${k}a`}
      x={ox * m}
      y={oy * m}
      width={7 * m}
      height={7 * m}
      rx={2.4 * m}
      fill="none"
      stroke={INK}
      strokeWidth={m}
    />,
    <rect
      key={`${k}b`}
      x={(ox + 2) * m}
      y={(oy + 2) * m}
      width={3 * m}
      height={3 * m}
      rx={1.1 * m}
      fill={ORANGE}
    />,
  ];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {cells}
      {finder(0, 0, 'f1')}
      {finder(n - 7, 0, 'f2')}
      {finder(0, n - 7, 'f3')}
    </svg>
  );
}
