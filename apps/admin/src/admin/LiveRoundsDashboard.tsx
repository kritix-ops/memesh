import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  getDashboardLive,
  type DashboardLiveAlert,
  type DashboardLiveResponse,
  type DashboardLiveRound,
  type DashboardLiveWaitlist,
  type DashboardLiveWeekAheadDay,
} from '../lib/api/admin';
import { useViewport } from '../useViewport';
import {
  computeStatusLevel,
  deltaDirection,
  deriveWeekAheadRows,
  formatIls,
  formatSigned,
  formatSignedPct,
  sortRoundsByStart,
  type StatusLevel,
} from './dashboard-live-logic';
import { card, INK, MUTED, ORANGE } from './reports/shared';

// ---------------------------------------------------------------------------
// Live operational dashboard (Super Brief §11.1.1). Mounted at the top of the
// admin landing. Polls GET /admin/dashboard/live at the operator-configured
// cadence, pausing while the tab is hidden. Option B single-column stack:
// rounds → numbers → alerts → waitlist → week-ahead, each above the legacy
// retrospective widgets. Empty zones render nothing (no placeholders).
//
// All display thresholds/cadence come from the response's `settings` block —
// nothing here is hardcoded except the palette. Revenue is gated server-side;
// the tile simply doesn't render when `revenueIls` is absent.
// ---------------------------------------------------------------------------

// Status bands. Full colour for text/marks, soft tint for pill/cell backgrounds.
const STATUS: Record<StatusLevel, { fg: string; bg: string }> = {
  green: { fg: '#0f9d58', bg: 'rgba(15,157,88,0.12)' },
  amber: { fg: '#b8860b', bg: 'rgba(244,180,0,0.16)' },
  red: { fg: '#d23f31', bg: 'rgba(210,63,49,0.12)' },
};
const CLOSED = { fg: MUTED, bg: '#f1efec' };
const TRACK = '#f3efea';

const HE_WEEKDAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

const zoneTitle: CSSProperties = { fontSize: 15, fontWeight: 600, color: INK };

/** Parse a "YYYY-MM-DD" date in the local timezone (avoids the UTC-midnight
 *  off-by-one that `new Date("YYYY-MM-DD")` causes in negative-offset zones). */
function parseLocalDate(ymd: string): Date {
  // Fixed-position slices of "YYYY-MM-DD" — Number(string) is always a number,
  // so this stays typed under noUncheckedIndexedAccess (array destructuring is not).
  return new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
}

/** Compact Hebrew relative time: "הרגע", "לפני 3 ד׳", "לפני 2 ש׳", "לפני 1 י׳". */
function fmtRelative(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'הרגע';
  if (m < 60) return `לפני ${m} ד׳`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} ש׳`;
  return `לפני ${Math.floor(h / 24)} י׳`;
}

export function LiveRoundsDashboard() {
  const { isMobile } = useViewport();
  const [data, setData] = useState<DashboardLiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const load = useCallback(async () => {
    const t0 = performance.now();
    const res = await getDashboardLive();
    const ms = Math.round(performance.now() - t0);
    if (res.ok) {
      setData(res.data);
      setError(null);
      console.info('[admin dashboard] fetch ok', {
        ms,
        rounds: res.data.today.rounds.length,
        alerts: res.data.alerts.length,
      });
    } else {
      setError(res.error);
      console.warn('[admin dashboard] fetch fail', { ms, error: res.error });
    }
  }, []);

  // Initial fetch on mount. Runs once (twice in StrictMode dev — harmless).
  useEffect(() => {
    console.info('[admin dashboard] mount');
    void load();
  }, [load]);

  const refreshSeconds = data?.settings.refreshIntervalSeconds ?? 30;

  // Poll on the configured cadence, pausing while the tab is hidden and doing an
  // immediate refresh when it comes back. Cleanup clears both the interval and
  // the listener, and is idempotent for StrictMode's extra setup/cleanup cycle.
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
        console.info('[admin dashboard] paused (tab hidden)');
      } else if (!id) {
        setPaused(false);
        console.info('[admin dashboard] resumed');
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

  // First load, nothing yet.
  if (!data) {
    if (error) {
      return (
        <div style={{ ...card, color: '#a23a3a' }}>
          לא ניתן לטעון את נתוני הזמן-אמת כרגע. הרענון הבא ינסה שוב.
        </div>
      );
    }
    return <div style={{ ...card, color: MUTED, textAlign: 'center' }}>טוען סבבים…</div>;
  }

  const { settings, today, alerts, waitlist, weekAhead } = data;
  const rounds = sortRoundsByStart(today.rounds);
  const s = today.stats;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Zone 1 — rounds today */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 10,
            flexWrap: 'wrap',
          }}
        >
          <div style={zoneTitle}>סבבי היום</div>
          <RefreshIndicator seconds={refreshSeconds} paused={paused} asOf={data.asOf} />
        </div>
        {rounds.length === 0 ? (
          <div style={{ ...card, color: MUTED, textAlign: 'center' }}>אין סבבים פעילים היום.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {rounds.map((r) => (
              <RoundTile
                key={r.roundInstanceId}
                round={r}
                warnPct={settings.capacityWarningPct}
                dangerPct={settings.capacityDangerPct}
              />
            ))}
          </div>
        )}
      </div>

      {/* Zone 2 — today in numbers */}
      <div>
        <div style={{ ...zoneTitle, marginBottom: 10 }}>היום במספרים</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {s.revenueIls !== undefined && (
            <LiveStatTile
              label="הכנסה היום"
              value={formatIls(s.revenueIls)}
              delta={s.revenueDeltaPct ?? null}
              kind="pct"
            />
          )}
          <LiveStatTile label="הזמנות היום" value={s.bookingsCount} delta={s.bookingsDelta} kind="count" />
          <LiveStatTile label="holds פעילים" value={s.activeHoldsCount} delta={null} kind="count" />
          <LiveStatTile
            label="כרטיסיות שנמכרו"
            value={s.punchCardsSold}
            delta={s.punchCardsDelta}
            kind="count"
          />
        </div>
      </div>

      {/* Zone 3 — alerts (hidden when none) */}
      {alerts.length > 0 && <AlertsZone alerts={alerts} />}

      {/* Zone 4 — waitlist (hidden when none) */}
      {waitlist.length > 0 && <WaitlistZone rows={waitlist} />}

      {/* Zone 5 — 7 days ahead (hidden by setting or when there are no rounds) */}
      {settings.showWeekAhead && weekAhead.some((d) => d.rounds.length > 0) && (
        <WeekAheadGrid
          days={weekAhead}
          warnPct={settings.capacityWarningPct}
          dangerPct={settings.capacityDangerPct}
          isMobile={isMobile}
        />
      )}
    </div>
  );
}

// --- Refresh indicator ------------------------------------------------------

function RefreshIndicator({
  seconds,
  paused,
  asOf,
}: {
  seconds: number;
  paused: boolean;
  asOf: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: MUTED }}>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: paused ? '#c9c9c9' : ORANGE,
          animation: paused ? undefined : 'memesh-ray 2s ease-in-out infinite',
        }}
      />
      {paused ? 'מושהה — החלון ברקע' : `רענון אוטומטי כל ${seconds} שנ׳`}
      <span style={{ color: '#b9b9b9' }}>·</span>
      <span>עודכן {fmtRelative(asOf)}</span>
    </div>
  );
}

// --- Round tile -------------------------------------------------------------

function StatusPill({ level, closed, pct }: { level: StatusLevel; closed: boolean; pct: number }) {
  const c = closed ? CLOSED : STATUS[level];
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: '2px 9px',
        borderRadius: 999,
        color: c.fg,
        background: c.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {closed ? 'סגור' : `${pct}%`}
    </span>
  );
}

function RoundTile({
  round,
  warnPct,
  dangerPct,
}: {
  round: DashboardLiveRound;
  warnPct: number;
  dangerPct: number;
}) {
  const level = computeStatusLevel(round.pctFull, warnPct, dangerPct);
  const barColor = round.isClosed ? '#d8d4cf' : STATUS[level].fg;
  const free = Math.max(0, round.capacity - round.taken);
  return (
    <div style={{ ...card, padding: 16, flex: '1 1 260px', minWidth: 240 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          {round.label}
          <span style={{ color: MUTED, fontWeight: 400, fontSize: 13, marginInlineStart: 8 }}>
            {round.startTime}–{round.endTime}
          </span>
        </div>
        <StatusPill level={level} closed={round.isClosed} pct={round.pctFull} />
      </div>
      <div style={{ marginTop: 12, height: 6, borderRadius: 4, background: TRACK, overflow: 'hidden' }}>
        <div
          style={{
            width: `${Math.min(100, round.pctFull)}%`,
            height: '100%',
            background: barColor,
            borderRadius: 4,
          }}
        />
      </div>
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span style={{ color: INK }}>
          {round.taken} / {round.capacity} ילדים
        </span>
        <span style={{ color: MUTED }}>{round.isClosed ? 'סבב סגור' : `${free} פנויים`}</span>
      </div>
      {round.heldCount > 0 && !round.isClosed && (
        <div style={{ marginTop: 4, fontSize: 12, color: MUTED }}>
          כולל {round.heldCount} שמורים זמנית
        </div>
      )}
    </div>
  );
}

// --- Live stat tile (value + optional day-over-day delta) -------------------

function LiveStatTile({
  label,
  value,
  delta,
  kind,
}: {
  label: string;
  value: string | number;
  delta: number | null;
  kind: 'count' | 'pct';
}) {
  const dir = deltaDirection(delta);
  const deltaColor =
    dir === 'up' ? STATUS.green.fg : dir === 'down' ? STATUS.red.fg : MUTED;
  const symbol = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '=';
  const magnitude =
    delta === null || dir === 'flat'
      ? ''
      : kind === 'pct'
        ? formatSignedPct(delta)
        : formatSigned(delta);
  return (
    <div style={{ ...card, flex: '1 1 160px', minWidth: 150, padding: '14px 18px' }}>
      <div style={{ color: MUTED, fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: INK, marginTop: 4 }}>{value}</div>
      {dir !== null && (
        <div style={{ fontSize: 12.5, color: deltaColor, marginTop: 3 }}>
          {dir === 'flat' ? (
            <span style={{ color: MUTED }}>ללא שינוי מאתמול</span>
          ) : (
            <>
              {symbol} {magnitude} <span style={{ color: MUTED }}>מאתמול</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --- Alerts zone (dormant until server-side detection lands) ----------------

function AlertsZone({ alerts }: { alerts: DashboardLiveAlert[] }) {
  return (
    <div style={card}>
      <div style={{ ...zoneTitle, color: STATUS.red.fg }}>התראות ({alerts.length})</div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {alerts.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => console.info('[admin dashboard] alert click', { kind: a.kind, id: a.id })}
            style={{
              textAlign: 'right',
              background: STATUS.red.bg,
              border: 'none',
              borderRadius: 10,
              padding: '10px 12px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ fontSize: 13.5, color: INK }}>{a.message}</span>
            <span style={{ fontSize: 12, color: MUTED, whiteSpace: 'nowrap' }}>
              {fmtRelative(a.occurredAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Waitlist zone ----------------------------------------------------------

function WaitlistZone({ rows }: { rows: DashboardLiveWaitlist[] }) {
  return (
    <div style={card}>
      <div style={zoneTitle}>רשימת המתנה</div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column' }}>
        {rows.map((w, i) => (
          <div
            key={w.roundInstanceId}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              padding: '9px 0',
              borderTop: i ? `1px solid ${TRACK}` : 'none',
              fontSize: 13.5,
            }}
          >
            <span style={{ fontWeight: 600 }}>
              {w.label}
              <span style={{ color: MUTED, fontWeight: 400, marginInlineStart: 8 }}>
                {w.waitingCount} ממתינים
              </span>
            </span>
            <span style={{ fontSize: 12.5, color: MUTED }}>
              {w.lastNotifiedAt ? `התראה אחרונה ${fmtRelative(w.lastNotifiedAt)}` : 'טרם נשלחה התראה'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Week-ahead grid --------------------------------------------------------

function WeekCell({
  pctFull,
  running,
  closed,
  level,
}: {
  pctFull: number | null;
  running: boolean;
  closed: boolean;
  level: StatusLevel;
}) {
  const inactive = !running || closed;
  const c = inactive ? CLOSED : STATUS[level];
  return (
    <div
      style={{
        minHeight: 30,
        borderRadius: 6,
        background: c.bg,
        color: c.fg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11.5,
        fontWeight: 600,
      }}
      title={inactive ? (closed ? 'סגור' : 'לא פעיל') : `${pctFull}%`}
    >
      {inactive ? '–' : `${pctFull}%`}
    </div>
  );
}

function WeekAheadGrid({
  days,
  warnPct,
  dangerPct,
  isMobile,
}: {
  days: DashboardLiveWeekAheadDay[];
  warnPct: number;
  dangerPct: number;
  isMobile: boolean;
}) {
  const rows = deriveWeekAheadRows(days);
  return (
    <div style={card}>
      <div style={{ ...zoneTitle, marginBottom: 12 }}>7 ימים קדימה</div>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `auto repeat(${days.length}, minmax(38px, 1fr))`,
            gap: 4,
            minWidth: isMobile ? 420 : undefined,
          }}
        >
          {/* header row: empty corner + weekday letters + date numbers */}
          <div />
          {days.map((d) => {
            const dt = parseLocalDate(d.date);
            return (
              <div
                key={d.date}
                style={{ textAlign: 'center', fontSize: 12, color: MUTED, fontWeight: 600 }}
              >
                <div>{HE_WEEKDAYS[dt.getDay()]}׳</div>
                <div style={{ fontSize: 11, fontWeight: 400 }}>{dt.getDate()}</div>
              </div>
            );
          })}

          {/* one row per distinct round, one cell per day */}
          {rows.map((row) => (
            <Row key={`${row.startTime}|${row.label}`}>
              <div
                style={{
                  fontSize: 12,
                  color: INK,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  paddingInlineEnd: 8,
                  whiteSpace: 'nowrap',
                }}
              >
                {row.startTime}
              </div>
              {days.map((d) => {
                const cell = d.rounds.find(
                  (r) => r.startTime === row.startTime && r.label === row.label,
                );
                const running = !!cell && cell.roundInstanceId !== null;
                const pctFull = cell ? cell.pctFull : null;
                const level =
                  running && pctFull !== null
                    ? computeStatusLevel(pctFull, warnPct, dangerPct)
                    : 'green';
                return (
                  <WeekCell
                    key={d.date}
                    pctFull={pctFull}
                    running={running}
                    closed={!!cell && cell.isClosed}
                    level={level}
                  />
                );
              })}
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}

// display:contents wrapper so each round's label + 7 cells share one grid row
// without an intermediate element breaking the CSS grid flow.
function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'contents' }}>{children}</div>;
}
