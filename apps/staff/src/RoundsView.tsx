import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { getStaffRoundsToday, type StaffRoundsResponse, type StaffRoundsRound } from './lib/api/rounds';

// Read-only rounds status for the shift floor. Mirrors the admin dashboard's
// rounds zone in spirit, but built for a cashier standing at the counter: big
// occupancy tiles, a plain-language action line per round ("full — send to
// waitlist" / "space — you can sell a walk-in"), and no money anywhere.
//
// Status logic + colors are a small local copy — apps can't cross-import, and
// these are a few pure lines. Kept in sync with the admin dashboard by eye.

const ORANGE = '#ffa983';
const INK = '#2d3436';
const MUTED = '#636e72';
const SHADOW = '0 4px 20px rgba(0,0,0,0.08)';
const TRACK = '#f3efea';

type StatusLevel = 'green' | 'amber' | 'red';
const STATUS: Record<StatusLevel, { fg: string; bg: string }> = {
  green: { fg: '#0f9d58', bg: 'rgba(15,157,88,0.12)' },
  amber: { fg: '#b8860b', bg: 'rgba(244,180,0,0.16)' },
  red: { fg: '#d23f31', bg: 'rgba(210,63,49,0.12)' },
};

function statusLevel(pct: number, warn: number, danger: number): StatusLevel {
  if (pct >= danger) return 'red';
  if (pct >= warn) return 'amber';
  return 'green';
}

const card: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 18,
};

function fmtRelative(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'הרגע';
  if (m < 60) return `לפני ${m} ד׳`;
  const h = Math.floor(m / 60);
  return `לפני ${h} ש׳`;
}

export function RoundsView() {
  const [data, setData] = useState<StaffRoundsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const load = useCallback(async () => {
    const res = await getStaffRoundsToday();
    if (res.ok) {
      setData(res.data);
      setError(null);
      console.info('[staff rounds] fetch ok', { rounds: res.data.rounds.length });
    } else {
      setError(res.error);
      console.warn('[staff rounds] fetch fail', { error: res.error });
    }
  }, []);

  useEffect(() => {
    console.info('[staff rounds] mount');
    void load();
  }, [load]);

  const refreshSeconds = data?.settings.refreshIntervalSeconds ?? 30;

  useEffect(() => {
    const tick = () => {
      void load();
    };
    let id: ReturnType<typeof setInterval> | null = setInterval(tick, refreshSeconds * 1000);
    const onVisibility = () => {
      if (document.hidden) {
        if (id) {
          clearInterval(id);
          id = null;
        }
        setPaused(true);
      } else if (!id) {
        setPaused(false);
        tick();
        id = setInterval(tick, refreshSeconds * 1000);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (id) clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshSeconds, load]);

  return (
    <main style={{ maxWidth: 920, margin: '0 auto', padding: '20px 16px 48px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 600, color: INK, margin: 0 }}>סבבי היום</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: MUTED }}>
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: paused ? '#c9c9c9' : ORANGE,
            }}
          />
          {paused ? 'מושהה' : 'מתעדכן אוטומטית'}
          {data && (
            <>
              <span style={{ color: '#c9c9c9' }}>·</span>
              <span>עודכן {fmtRelative(data.asOf)}</span>
            </>
          )}
        </div>
      </div>

      {!data ? (
        error ? (
          <div style={{ ...card, color: '#a23a3a' }}>
            לא ניתן לטעון את סטטוס הסבבים כרגע. ננסה שוב בעוד רגע.
          </div>
        ) : (
          <div style={{ ...card, color: MUTED, textAlign: 'center' }}>טוען…</div>
        )
      ) : data.rounds.length === 0 ? (
        <div style={{ ...card, color: MUTED, textAlign: 'center' }}>אין סבבים היום.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[...data.rounds]
            .sort((a, b) => a.startTime.localeCompare(b.startTime))
            .map((round) => {
              const waiting =
                data.waitlist.find((w) => w.roundInstanceId === round.roundInstanceId)
                  ?.waitingCount ?? 0;
              return (
                <RoundStatusCard
                  key={round.roundInstanceId}
                  round={round}
                  warnPct={data.settings.capacityWarningPct}
                  dangerPct={data.settings.capacityDangerPct}
                  waitingCount={waiting}
                />
              );
            })}
        </div>
      )}
    </main>
  );
}

function RoundStatusCard({
  round,
  warnPct,
  dangerPct,
  waitingCount,
}: {
  round: StaffRoundsRound;
  warnPct: number;
  dangerPct: number;
  waitingCount: number;
}) {
  const level = statusLevel(round.pctFull, warnPct, dangerPct);
  const free = Math.max(0, round.capacity - round.taken);
  const barColor = round.isClosed ? '#d8d4cf' : STATUS[level].fg;
  const pill = round.isClosed ? { fg: MUTED, bg: '#f1efec' } : STATUS[level];

  // Plain action line — what the cashier should do about this round.
  let action: { text: string; tone: string };
  if (round.isClosed) {
    action = { text: 'הסבב סגור היום.', tone: MUTED };
  } else if (free <= 0) {
    action = {
      text:
        waitingCount > 0
          ? `מלא. אין כניסה במקום — הפנו לרשימת המתנה (${waitingCount} ממתינים) או הציעו סבב אחר.`
          : 'מלא. אין כניסה במקום — הפנו לרשימת המתנה או הציעו סבב אחר.',
      tone: STATUS.red.fg,
    };
  } else if (level === 'amber' || level === 'red') {
    action = { text: `כמעט מלא — נותרו ${free} מקומות. אפשר עוד כניסה במקום.`, tone: STATUS.amber.fg };
  } else {
    action = { text: `יש מקום — ${free} פנויים. אפשר למכור כניסה במקום.`, tone: STATUS.green.fg };
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 17, color: INK }}>
          {round.label}
          <span style={{ color: MUTED, fontWeight: 400, fontSize: 14, marginInlineStart: 8 }}>
            {round.startTime}–{round.endTime}
          </span>
        </div>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            padding: '3px 10px',
            borderRadius: 999,
            color: pill.fg,
            background: pill.bg,
            whiteSpace: 'nowrap',
          }}
        >
          {round.isClosed ? 'סגור' : `${round.pctFull}%`}
        </span>
      </div>

      <div style={{ marginTop: 12, height: 8, borderRadius: 5, background: TRACK, overflow: 'hidden' }}>
        <div
          style={{
            width: `${Math.min(100, round.pctFull)}%`,
            height: '100%',
            background: barColor,
            borderRadius: 5,
          }}
        />
      </div>

      <div
        style={{
          marginTop: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 15, color: INK }}>
          {round.taken} / {round.capacity} ילדים
        </span>
        {!round.isClosed && (
          <span style={{ fontSize: 20, fontWeight: 600, color: barColor }}>
            {free} <span style={{ fontSize: 13, fontWeight: 400, color: MUTED }}>פנויים</span>
          </span>
        )}
      </div>

      <div style={{ marginTop: 8, fontSize: 14, color: action.tone, lineHeight: 1.5 }}>
        {action.text}
      </div>
    </div>
  );
}
