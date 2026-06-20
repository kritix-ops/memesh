import type { CSSProperties, ReactNode } from 'react';
import { GREEN, INK, MUTED, ORANGE } from './tokens';

interface SunProps {
  size?: number;
  ring?: boolean;
  spin?: boolean;
}

// The brand's primary mark: a ring (or solid center) with 8 rounded-pebble rays
// alternating orange and green.
export function Sun({ size = 46, ring = true, spin = false }: SunProps) {
  const cx = size / 2;
  const cy = size / 2;
  const rayW = size * 0.115;
  const rayLen = size * 0.2;
  const orbit = size * 0.34;
  const rays = Array.from({ length: 8 }, (_, i) => (
    <rect
      key={i}
      x={cx - rayW / 2}
      y={cy - orbit - rayLen}
      width={rayW}
      height={rayLen}
      rx={rayW / 2}
      fill={i % 2 === 0 ? ORANGE : GREEN}
      transform={`rotate(${i * 45} ${cx} ${cy})`}
      style={spin ? { animation: `memesh-ray 1.1s ease-in-out ${i * 0.12}s infinite` } : undefined}
    />
  ));
  const center = ring ? (
    <circle
      cx={cx}
      cy={cy}
      r={size * 0.15}
      fill="none"
      stroke={ORANGE}
      strokeWidth={Math.max(2, size * 0.055)}
    />
  ) : (
    <circle cx={cx} cy={cy} r={size * 0.17} fill={ORANGE} />
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
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

export function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Sun size={34} ring={false} />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
        <span style={{ fontSize: 26, fontWeight: 600, color: ORANGE }}>ממש</span>
        <span style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>משחקיה, בית, קהילה</span>
      </div>
    </div>
  );
}

// A decorative QR placeholder derived from the serial. The production build
// renders the real HMAC token via a QR library; this is for the mock UI only.
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
