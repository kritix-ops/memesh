import {
  addMonths,
  firstOfMonth,
  labelHasTime,
  monthGrid,
  monthLabelHe,
  monthOfIso,
} from '@memesh/web-shared';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { createCustomer, searchCustomers, type Customer } from './lib/api/customers';
import {
  addWalkIn,
  getRoundAttendees,
  getRoundAvailabilityRange,
  getStaffRounds,
  moveBooking,
  setBookingArrival,
  type RoundAttendee,
  type StaffDayAvailability,
  type StaffRoundsResponse,
  type StaffRoundsRound,
} from './lib/api/rounds';

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

// True once a round's end time (plus the marking grace) has passed. The floor
// tablet runs in Israel, so the browser's local wall-clock is the venue's — a
// plain minutes-of-day compare. The server (setBookingArrival) is the authority
// on the same grace; this only greys the controls so staff don't tap a round
// that's already closed for marking (Yanay 2026-07-13).
function markingClosedLocal(endTimeHhmm: string, graceMinutes: number, now: Date): boolean {
  const hhmm = endTimeHhmm.slice(0, 5);
  const endMin = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return endMin + graceMinutes <= now.getHours() * 60 + now.getMinutes();
}

const card: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 18,
};

const navBtn: CSSProperties = {
  width: 38,
  height: 38,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1.5px solid #e9e0d9',
  borderRadius: 10,
  background: '#fff',
  color: INK,
  fontSize: 18,
  cursor: 'pointer',
};

/** ISO timestamp → venue-local "HH:MM" (check-in times on the attendee list). */
function fmtTimeHe(iso: string): string {
  return new Date(iso).toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  });
}

function fmtRelative(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'הרגע';
  if (m < 60) return `לפני ${m} ד׳`;
  const h = Math.floor(m / 60);
  return `לפני ${h} ש׳`;
}

function localIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`); // noon avoids DST edges
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

const WEEKDAY_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const WEEKDAY_HE_SHORT = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

function fmtIsoDateHe(iso: string): string {
  const [y, m, d] = iso.split('-');
  const weekday = WEEKDAY_HE[new Date(`${iso}T12:00:00`).getDay()];
  return `יום ${weekday} · ${d}/${m}/${y}`;
}

// Day-strip dot for the two-week jumper (plan 2026-07-05-rounds-day-strip):
// aggregated occupancy against the same warn/danger thresholds as the tiles,
// so the strip and the tiles never disagree about a day. 'closed' = an admin
// rule shut the day, 'free' = free play (nothing to book), 'none' = rounds
// required but none offered.
type StripStatus = StatusLevel | 'free' | 'closed' | 'none';

function stripStatus(d: StaffDayAvailability, warnPct: number, dangerPct: number): StripStatus {
  if (d.closed) return 'closed';
  const open = d.rounds.filter((r) => !r.isClosed);
  if (open.length === 0) return d.roundsRequired ? 'none' : 'free';
  const capacity = open.reduce((s, r) => s + r.capacity, 0);
  const available = open.reduce((s, r) => s + r.available, 0);
  if (available === 0) return 'red';
  const pct = capacity > 0 ? Math.round(((capacity - available) / capacity) * 100) : 0;
  return statusLevel(pct, warnPct, dangerPct);
}

const STRIP_DOT: Record<StripStatus, string> = {
  green: STATUS.green.fg,
  amber: STATUS.amber.fg,
  red: STATUS.red.fg,
  free: '#a9bac6',
  closed: '#8a7f76',
  none: '#d9d2c9',
};

// Month calendar over the whole booking window (plan
// 2026-07-05-booking-window-365): the native date input jumps anywhere, but
// only this shows the availability dots, so a shift lead can eyeball a far
// month the way customers see it. Pure presentation — the parent owns the day
// cache and the fetching; cells outside [todayIso, maxDate] are disabled.
function StaffMonthCalendar({
  month,
  todayIso,
  maxDate,
  selectedDate,
  loading,
  dotFor,
  onMonthChange,
  onPick,
}: {
  month: string;
  todayIso: string;
  maxDate: string | null;
  selectedDate: string;
  loading: boolean;
  dotFor: (dateIso: string) => string | undefined;
  onMonthChange: (ym: string) => void;
  onPick: (dateIso: string) => void;
}) {
  const { leadingBlanks, dates } = monthGrid(month);
  const canPrev = month > monthOfIso(todayIso);
  const canNext = maxDate !== null && month < monthOfIso(maxDate);
  return (
    <div
      style={{
        border: '1.5px solid #e9e0d9',
        borderRadius: 12,
        padding: 12,
        marginTop: 8,
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* RTL: the past sits to the right, so the right-hand button walks back. */}
        <button
          type="button"
          aria-label="חודש קודם"
          disabled={!canPrev}
          onClick={() => canPrev && onMonthChange(addMonths(month, -1))}
          style={{
            ...navBtn,
            color: canPrev ? INK : '#d9d2c9',
            cursor: canPrev ? 'pointer' : 'default',
          }}
        >
          ›
        </button>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: INK }}>{monthLabelHe(month)}</div>
        <button
          type="button"
          aria-label="חודש הבא"
          disabled={!canNext}
          onClick={() => canNext && onMonthChange(addMonths(month, 1))}
          style={{
            ...navBtn,
            color: canNext ? INK : '#d9d2c9',
            cursor: canNext ? 'pointer' : 'default',
          }}
        >
          ‹
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {WEEKDAY_HE_SHORT.map((l) => (
          <span
            key={l}
            style={{ textAlign: 'center', fontSize: 10.5, color: MUTED, fontWeight: 600 }}
          >
            {l}׳
          </span>
        ))}
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <span key={`blank-${i}`} />
        ))}
        {dates.map((dateIso) => {
          const dot = dotFor(dateIso);
          const inWindow =
            dateIso >= todayIso && (maxDate === null || dateIso <= maxDate) && dot !== undefined;
          const active = selectedDate === dateIso;
          return (
            <button
              key={dateIso}
              type="button"
              disabled={!inWindow}
              aria-label={fmtIsoDateHe(dateIso)}
              onClick={() => inWindow && onPick(dateIso)}
              style={{
                border: `1.5px solid ${active ? ORANGE : 'transparent'}`,
                background: active ? '#fff4ec' : 'transparent',
                borderRadius: 9,
                padding: '5px 0 4px',
                cursor: inWindow ? 'pointer' : 'default',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
              }}
            >
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: active ? 700 : 500,
                  color: inWindow ? INK : '#d9d2c9',
                }}
              >
                {Number(dateIso.slice(8, 10))}
              </span>
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: inWindow && dot ? dot : 'transparent',
                }}
              />
            </button>
          );
        })}
      </div>
      {loading && (
        <div style={{ textAlign: 'center', color: MUTED, fontSize: 12.5 }}>טוען חודש…</div>
      )}
    </div>
  );
}

export function RoundsView() {
  const todayIso = localIsoDate(new Date());
  const [date, setDate] = useState(todayIso);
  const [data, setData] = useState<StaffRoundsResponse | null>(null);
  const [strip, setStrip] = useState<StaffDayAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  // Month calendar over the whole booking window; every fetched day lands in
  // dayCache so revisited months render instantly.
  const [calOpen, setCalOpen] = useState(false);
  const [calMonth, setCalMonth] = useState<string | null>(null);
  const [calLoading, setCalLoading] = useState(false);
  const [maxDate, setMaxDate] = useState<string | null>(null);
  const [dayCache, setDayCache] = useState<Map<string, StaffDayAvailability>>(new Map());
  const isToday = date === todayIso;

  const load = useCallback(async () => {
    // Always send the explicit date — letting the server infer "today" once
    // showed Saturday's (empty) rounds under a Sunday header, because the
    // server clock runs on UTC (Yoav 2026-07-05).
    const res = await getStaffRounds(date);
    if (res.ok) {
      setData(res.data);
      setError(null);
      console.info('[staff rounds] fetch ok', { date, rounds: res.data.rounds.length });
    } else {
      setError(res.error);
      console.warn('[staff rounds] fetch fail', { date, error: res.error });
    }
  }, [date]);

  // The two-week strip refreshes with the tiles so the dots stay live too.
  const loadStrip = useCallback(async () => {
    const res = await getRoundAvailabilityRange();
    if (res.ok) {
      setStrip(res.data.days);
      setMaxDate(res.data.maxDate);
      setDayCache((cur) => {
        const next = new Map(cur);
        for (const d of res.data.days) next.set(d.date, d);
        return next;
      });
      console.info('[staff rounds] strip ok', { days: res.data.days.length });
    } else {
      console.warn('[staff rounds] strip fail', { error: res.error });
    }
  }, []);

  useEffect(() => {
    console.info('[staff rounds] mount/date', { date });
    void load();
  }, [load, date]);

  useEffect(() => {
    void loadStrip();
  }, [loadStrip]);

  // The calendar pages the booking window one month per fetch; each month is
  // remembered until the page reloads.
  useEffect(() => {
    if (!calOpen || !calMonth) return;
    const { dates } = monthGrid(calMonth);
    if (!dates.some((d) => !dayCache.has(d))) return;
    let cancelled = false;
    setCalLoading(true);
    void (async () => {
      const res = await getRoundAvailabilityRange(dates.length, firstOfMonth(calMonth));
      console.info('[staff rounds] calendar month', {
        month: calMonth,
        ok: res.ok,
        days: res.ok ? res.data.days.length : 0,
        error: res.ok ? undefined : res.error,
      });
      if (cancelled) return;
      setCalLoading(false);
      if (!res.ok) return;
      setDayCache((cur) => {
        const next = new Map(cur);
        for (const d of res.data.days) next.set(d.date, d);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calOpen, calMonth]);

  const refreshSeconds = data?.settings.refreshIntervalSeconds ?? 30;

  useEffect(() => {
    const tick = () => {
      void load();
      void loadStrip();
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
  }, [refreshSeconds, load, loadStrip]);

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
        <h1 style={{ fontSize: 22, fontWeight: 600, color: INK, margin: 0 }}>
          {isToday ? 'סבבי היום' : 'סבבים'}
        </h1>
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

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          onClick={() => setDate((d) => shiftIsoDate(d, -1))}
          aria-label="יום קודם"
          style={navBtn}
        >
          ‹
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: INK }}>{fmtIsoDateHe(date)}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            aria-label="בחירת תאריך"
            style={{
              padding: '7px 10px',
              borderRadius: 9,
              border: '1.5px solid #e9e0d9',
              fontSize: 13.5,
              background: '#fff',
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => setDate((d) => shiftIsoDate(d, 1))}
          aria-label="יום הבא"
          style={navBtn}
        >
          ›
        </button>
        {!isToday && (
          <button
            type="button"
            onClick={() => setDate(localIsoDate(new Date()))}
            style={{
              ...navBtn,
              width: 'auto',
              padding: '0 14px',
              fontSize: 13.5,
              fontWeight: 600,
            }}
          >
            היום
          </button>
        )}
      </div>

      {strip && strip.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            {/* Fixed beside the strip: opens the month calendar with the same
                availability dots, out to the end of the booking window. */}
            <button
              type="button"
              title="לוח שנה עם זמינות"
              onClick={() => {
                setCalMonth((m) => m ?? monthOfIso(date >= todayIso ? date : todayIso));
                setCalOpen((v) => !v);
                console.info('[staff rounds] calendar toggle', { open: !calOpen });
              }}
              style={{
                flex: '0 0 auto',
                minWidth: 52,
                border: `1.5px solid ${calOpen ? ORANGE : '#e9e0d9'}`,
                background: calOpen ? '#fff4ec' : '#fff',
                borderRadius: 12,
                padding: '8px 6px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
              }}
            >
              <span style={{ fontSize: 17, lineHeight: 1 }}>📅</span>
              <span style={{ fontSize: 9.5, color: MUTED, fontWeight: 600 }}>לוח שנה</span>
            </button>
            <div
              style={{
                display: 'flex',
                gap: 6,
                overflowX: 'auto',
                padding: '2px 2px 4px',
                flex: 1,
                minWidth: 0,
              }}
            >
              {strip.map((d, i) => {
                const active = date === d.date;
                const warnPct = data?.settings.capacityWarningPct ?? 70;
                const dangerPct = data?.settings.capacityDangerPct ?? 90;
                const status = stripStatus(d, warnPct, dangerPct);
                return (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() => setDate(d.date)}
                    aria-label={fmtIsoDateHe(d.date)}
                    style={{
                      flex: '0 0 auto',
                      minWidth: 52,
                      border: `1.5px solid ${active ? ORANGE : '#e9e0d9'}`,
                      background: active ? '#fff4ec' : '#fff',
                      borderRadius: 12,
                      padding: '8px 6px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <span style={{ fontSize: 10.5, color: MUTED, fontWeight: 600 }}>
                      {i === 0
                        ? 'היום'
                        : `${WEEKDAY_HE_SHORT[new Date(`${d.date}T12:00:00`).getDay()]}׳`}
                    </span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>
                      {Number(d.date.slice(8, 10))}
                    </span>
                    <span
                      aria-hidden
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: STRIP_DOT[status],
                      }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
          {calOpen && calMonth && (
            <StaffMonthCalendar
              month={calMonth}
              todayIso={todayIso}
              maxDate={maxDate}
              selectedDate={date}
              loading={calLoading}
              dotFor={(dateIso) => {
                const day = dayCache.get(dateIso);
                if (!day) return undefined;
                const warnPct = data?.settings.capacityWarningPct ?? 70;
                const dangerPct = data?.settings.capacityDangerPct ?? 90;
                return STRIP_DOT[stripStatus(day, warnPct, dangerPct)];
              }}
              onMonthChange={setCalMonth}
              onPick={(dateIso) => {
                console.info('[staff rounds] calendar pick', { date: dateIso });
                setDate(dateIso);
                setCalOpen(false);
              }}
            />
          )}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px 12px',
              justifyContent: 'center',
              fontSize: 11.5,
              color: MUTED,
              marginTop: 6,
            }}
          >
            {(
              [
                ['green', 'פנוי'],
                ['amber', 'מתמלא'],
                ['red', 'מלא'],
                ['free', 'כניסה חופשית'],
                ['closed', 'סגור'],
              ] as const
            ).map(([k, label]) => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span
                  aria-hidden
                  style={{ width: 7, height: 7, borderRadius: '50%', background: STRIP_DOT[k] }}
                />
                {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {!data ? (
        error ? (
          <div style={{ ...card, color: '#a23a3a' }}>
            לא ניתן לטעון את סטטוס הסבבים כרגע. ננסה שוב בעוד רגע.
          </div>
        ) : (
          <div style={{ ...card, color: MUTED, textAlign: 'center' }}>טוען…</div>
        )
      ) : data.rounds.length === 0 ? (
        <div style={{ ...card, color: MUTED, textAlign: 'center' }}>
          {strip?.find((d) => d.date === date)?.closed
            ? 'המקום סגור בתאריך זה.'
            : isToday
              ? 'אין סבבים היום.'
              : 'אין סבבים בתאריך זה.'}
        </div>
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
                  roundsToday={data.rounds}
                  warnPct={data.settings.capacityWarningPct}
                  dangerPct={data.settings.capacityDangerPct}
                  waitingCount={waiting}
                  canMark={
                    isToday &&
                    !markingClosedLocal(round.endTime, data.settings.markingGraceMinutes, new Date())
                  }
                  onArrivalChanged={() => void load()}
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
  roundsToday,
  warnPct,
  dangerPct,
  waitingCount,
  canMark,
  onArrivalChanged,
}: {
  round: StaffRoundsRound;
  /** All of the day's rounds — the move-target picker lists the other open ones. */
  roundsToday: StaffRoundsRound[];
  warnPct: number;
  dangerPct: number;
  waitingCount: number;
  /**
   * Arrival + move + walk-in controls only make sense when the page shows today
   * AND the round is still running — a finished round is read-only.
   */
  canMark: boolean;
  onArrivalChanged: () => void;
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
    action = {
      text: `כמעט מלא — נותרו ${free} מקומות. אפשר עוד כניסה במקום.`,
      tone: STATUS.amber.fg,
    };
  } else {
    action = { text: `יש מקום — ${free} פנויים. אפשר למכור כניסה במקום.`, tone: STATUS.green.fg };
  }

  return (
    <div style={card}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
      >
        <div style={{ fontWeight: 600, fontSize: 17, color: INK }}>
          {round.label}
          {!labelHasTime(round.label) && (
            <span style={{ color: MUTED, fontWeight: 400, fontSize: 14, marginInlineStart: 8 }}>
              {round.startTime}–{round.endTime}
            </span>
          )}
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

      <div
        style={{ marginTop: 12, height: 8, borderRadius: 5, background: TRACK, overflow: 'hidden' }}
      >
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

      {!round.isClosed && round.heldCount > 0 && (
        <div style={{ marginTop: 6, fontSize: 13.5, color: MUTED }}>
          מתוכם {round.heldCount} בתהליך תשלום — שריון זמני שמשתחרר לבד אם הרכישה לא מושלמת
        </div>
      )}

      {round.bookedCount > 0 && (
        <div style={{ marginTop: 8, fontSize: 14.5, color: INK }}>
          <strong style={{ color: round.arrivedCount > 0 ? STATUS.green.fg : INK }}>
            {round.arrivedCount}
          </strong>{' '}
          הגיעו מתוך {round.bookedCount} שהזמינו
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 14, color: action.tone, lineHeight: 1.5 }}>
        {action.text}
      </div>

      {(round.bookedCount > 0 || canMark) && !round.isClosed && (
        <AttendeesSection
          round={round}
          roundsToday={roundsToday}
          canMark={canMark}
          onArrivalChanged={onArrivalChanged}
        />
      )}
    </div>
  );
}

// Lazy "מי הגיע?" list — fetched only when the cashier opens it, searchable
// by name so a customer at the counter is found in a keystroke or two. On
// today's rounds every row carries the manual check-in control: the floor
// often doesn't scan (Yanay 2026-07-05), so arrival is marked by tap.
function AttendeesSection({
  round,
  roundsToday,
  canMark,
  onArrivalChanged,
}: {
  round: StaffRoundsRound;
  roundsToday: StaffRoundsRound[];
  canMark: boolean;
  onArrivalChanged: () => void;
}) {
  const roundInstanceId = round.roundInstanceId;
  const [open, setOpen] = useState(false);
  const [attendees, setAttendees] = useState<RoundAttendee[] | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [addingWalkIn, setAddingWalkIn] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const moveTargets = roundsToday.filter(
    (r) => r.roundInstanceId !== roundInstanceId && !r.isClosed,
  );

  const fetchAttendees = async () => {
    const res = await getRoundAttendees(roundInstanceId);
    if (res.ok) setAttendees(res.data.attendees);
    else setError(true);
  };

  const doMove = async (a: RoundAttendee, targetId: string) => {
    setBusyId(a.bookingId);
    setMarkError(null);
    console.info('[staff attendees] move', { bookingId: a.bookingId, targetId });
    const res = await moveBooking(a.bookingId, targetId);
    setBusyId(null);
    setMoveFor(null);
    if (!res.ok) {
      setMarkError(
        res.error === 'target_full'
          ? 'הסבב שנבחר מלא. אפשר להוסיף כ"נוסף ידנית" מעל התפוסה.'
          : res.error === 'target_closed'
            ? 'הסבב שנבחר סגור.'
            : 'ההעברה נכשלה. נסו שוב.',
      );
      return;
    }
    const target = roundsToday.find((r) => r.roundInstanceId === targetId);
    setFlash(`${a.firstName} הועבר/ה ל${target?.label ?? 'סבב אחר'}`);
    setTimeout(() => setFlash(null), 4000);
    await fetchAttendees();
    onArrivalChanged();
  };

  const mark = async (a: RoundAttendee, arrived: boolean) => {
    setBusyId(a.bookingId);
    setMarkError(null);
    console.info('[staff attendees] mark', { bookingId: a.bookingId, arrived });
    const res = await setBookingArrival(a.bookingId, arrived);
    setBusyId(null);
    if (!res.ok) {
      console.warn('[staff attendees] mark fail', { bookingId: a.bookingId, error: res.error });
      setMarkError(
        res.error === 'not_today'
          ? 'אפשר לסמן הגעה רק ביום הסבב עצמו.'
          : res.error === 'round_ended'
            ? 'הסבב הסתיים — לא ניתן לסמן הגעה.'
            : 'לא ניתן לעדכן כרגע. נסו שוב.',
      );
      return;
    }
    setAttendees(
      (prev) =>
        prev?.map((x) =>
          x.bookingId === a.bookingId
            ? { ...x, arrived: res.data.arrived, usedAt: res.data.usedAt }
            : x,
        ) ?? prev,
    );
    // Refresh the tiles so "הגיעו X" moves with the tap.
    onArrivalChanged();
  };

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && attendees === null) {
      console.info('[staff attendees] fetch', { roundInstanceId });
      await fetchAttendees();
    }
  };

  const filtered = (attendees ?? []).filter((a) =>
    `${a.firstName} ${a.lastName} ${a.phone}`.includes(q.trim()),
  );

  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${TRACK}`, paddingTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => void toggle()}
          style={{
            border: 'none',
            background: 'transparent',
            color: MUTED,
            fontSize: 13.5,
            fontWeight: 600,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {open
            ? 'הסתרת הרשימה ▲'
            : round.bookedCount > 0
              ? 'מי הגיע? הצגת הרשימה ▼'
              : 'ניהול משתתפים ▼'}
        </button>
        {canMark && open && !addingWalkIn && (
          <button
            type="button"
            onClick={() => setAddingWalkIn(true)}
            style={{
              border: 'none',
              background: ORANGE,
              color: '#fff',
              borderRadius: 999,
              padding: '6px 14px',
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            + הוספת משתתף
          </button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {flash && (
            <div style={{ fontSize: 12.5, color: '#0f7a44', background: '#eef7ee', borderRadius: 8, padding: '7px 10px', marginBottom: 8 }}>
              {flash}
            </div>
          )}
          {addingWalkIn && (
            <StaffWalkInForm
              roundInstanceId={roundInstanceId}
              onCancel={() => setAddingWalkIn(false)}
              onAdded={async (name, over) => {
                setAddingWalkIn(false);
                setFlash(`${name} נוסף/ה לסבב${over ? ' · מעל התפוסה' : ''}`);
                setTimeout(() => setFlash(null), 4000);
                await fetchAttendees();
                onArrivalChanged();
              }}
            />
          )}
          {error ? (
            <div style={{ fontSize: 13, color: '#a23a3a' }}>לא ניתן לטעון את הרשימה כרגע.</div>
          ) : attendees === null ? (
            <div style={{ fontSize: 13, color: MUTED }}>טוען…</div>
          ) : (
            <>
              {attendees.length > 5 && (
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="חיפוש לפי שם או טלפון…"
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '8px 12px',
                    borderRadius: 9,
                    border: '1.5px solid #e9e0d9',
                    fontSize: 13.5,
                    marginBottom: 8,
                  }}
                />
              )}
              {filtered.length === 0 ? (
                <div style={{ fontSize: 13, color: MUTED }}>
                  {q ? 'אין תוצאות לחיפוש הזה.' : 'אין עדיין הזמנות לסבב הזה.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {filtered.map((a) => (
                    <div
                      key={a.bookingId}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        fontSize: 14,
                        padding: '6px 10px',
                        background: a.arrived ? 'rgba(15,157,88,0.07)' : '#faf8f6',
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: INK, minWidth: 0 }}>
                        {a.firstName} {a.lastName}
                        {a.source === 'manual' && (
                          <span
                            style={{
                              marginInlineStart: 6,
                              fontSize: 10.5,
                              fontWeight: 700,
                              color: '#b9772a',
                              background: '#fdf3e3',
                              borderRadius: 999,
                              padding: '1px 7px',
                            }}
                          >
                            נוסף/ה ידנית
                          </span>
                        )}
                        <span style={{ color: MUTED, fontSize: 12.5, marginInlineStart: 6 }}>
                          {a.ticketType === 'child_under_walking' ? 'תינוק/ת' : 'ילד/ה'}
                          {a.additionalCompanions > 0 ? ' · +מלווה נוסף' : ''}
                        </span>
                        <span style={{ display: 'block', fontSize: 12.5, marginTop: 2 }}>
                          {a.bookingNumber && (
                            <span style={{ color: MUTED }} dir="ltr">
                              {a.bookingNumber}
                              {' · '}
                            </span>
                          )}
                          {a.anonymous ? (
                            // Cash walk-in with no info collected — no real phone
                            // or email to show, so the booking number stands in.
                            <span style={{ color: MUTED }}>מזומן · ללא פרטים</span>
                          ) : (
                            <>
                              <a
                                href={`tel:${a.phone}`}
                                style={{ color: MUTED, textDecoration: 'none' }}
                                dir="ltr"
                              >
                                {a.phone}
                              </a>
                              {a.email && (
                                <span style={{ color: '#c9c9c9' }}>
                                  {' · '}
                                  <span style={{ color: MUTED }} dir="ltr">
                                    {a.email}
                                  </span>
                                </span>
                              )}
                            </>
                          )}
                        </span>
                      </span>
                      {!canMark ? (
                        <span
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            color: a.arrived ? STATUS.green.fg : MUTED,
                          }}
                        >
                          {a.arrived ? '✓ הגיעו' : 'טרם הגיעו'}
                        </span>
                      ) : a.arrived ? (
                        <span
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'flex-end',
                            gap: 2,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: STATUS.green.fg }}>
                            ✓ הגיעו{a.usedAt ? ` · ${fmtTimeHe(a.usedAt)}` : ''}
                          </span>
                          <button
                            type="button"
                            disabled={busyId === a.bookingId}
                            onClick={() => void mark(a, false)}
                            style={{
                              border: 'none',
                              background: 'transparent',
                              color: MUTED,
                              fontSize: 11.5,
                              cursor: 'pointer',
                              padding: 0,
                              textDecoration: 'underline',
                            }}
                          >
                            ביטול
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busyId === a.bookingId}
                          onClick={() => void mark(a, true)}
                          style={{
                            border: 'none',
                            background: STATUS.green.fg,
                            color: '#fff',
                            borderRadius: 999,
                            padding: '7px 14px',
                            fontSize: 12.5,
                            fontWeight: 600,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            opacity: busyId === a.bookingId ? 0.6 : 1,
                          }}
                        >
                          סמן הגעה
                        </button>
                      )}
                      </div>

                      {canMark && moveTargets.length > 0 && (
                        moveFor === a.bookingId ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', borderTop: `1px solid ${TRACK}`, paddingTop: 6 }}>
                            <span style={{ fontSize: 12, color: MUTED }}>העברה אל:</span>
                            {moveTargets.map((t) => (
                              <button
                                key={t.roundInstanceId}
                                type="button"
                                disabled={busyId === a.bookingId}
                                onClick={() => void doMove(a, t.roundInstanceId)}
                                style={{
                                  border: '1.5px solid #e9e0d9',
                                  background: '#fff',
                                  color: INK,
                                  borderRadius: 8,
                                  padding: '5px 10px',
                                  fontSize: 12,
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                }}
                              >
                                {t.label} {t.startTime}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => setMoveFor(null)}
                              style={{ border: 'none', background: 'transparent', color: MUTED, fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}
                            >
                              ביטול
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setMoveFor(a.bookingId)}
                            style={{ alignSelf: 'flex-start', border: 'none', background: 'transparent', color: MUTED, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                          >
                            העברה לסבב אחר
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              )}
              {markError && (
                <div style={{ fontSize: 12.5, color: '#a23a3a', marginTop: 8 }}>{markError}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Maps a walk-in add failure to a floor-friendly line. Shared by the named,
// quick-create, and anonymous add paths.
function walkInErrorMessage(error: string): string {
  if (error === 'round_full') return 'הסבב מלא והוספה מעל התפוסה כבויה בהגדרות.';
  if (error === 'round_closed') return 'הסבב סגור.';
  return 'ההוספה נכשלה. נסו שוב.';
}

// Walk-in add for the floor: take a cash entry with no info collected, or search
// an existing customer / quick-add a new one, then add them to the round (over
// capacity when the venue allows it).
function StaffWalkInForm({
  roundInstanceId,
  onCancel,
  onAdded,
}: {
  roundInstanceId: string;
  onCancel: () => void;
  onAdded: (customerName: string, overCapacity: boolean) => void | Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (creating) return;
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const res = await searchCustomers(term, { signal: ctrl.signal });
      if (res.ok) setResults(res.data.results);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q, creating]);

  const add = async (customerId: string, name: string) => {
    setBusy(true);
    setError(null);
    console.info('[staff attendees] walk-in add', { roundInstanceId, customerId });
    const res = await addWalkIn(roundInstanceId, { customerId });
    setBusy(false);
    if (!res.ok) {
      setError(walkInErrorMessage(res.error));
      return;
    }
    await onAdded(name, res.data.overCapacity);
  };

  // Cash entry, no info collected (Yanay 2026-07-13): one tap adds an anonymous
  // head to the round under the reserved walk-in customer.
  const addAnonymous = async () => {
    setBusy(true);
    setError(null);
    console.info('[staff attendees] walk-in anonymous add', { roundInstanceId });
    const res = await addWalkIn(roundInstanceId, { anonymous: true });
    setBusy(false);
    if (!res.ok) {
      setError(walkInErrorMessage(res.error));
      return;
    }
    await onAdded('כניסה במקום', res.data.overCapacity);
  };

  const quickAdd = async () => {
    if (!first.trim() || !phone.trim()) return;
    setBusy(true);
    setError(null);
    console.info('[staff attendees] walk-in quick-create', { phone: phone.trim() });
    const created = await createCustomer({ firstName: first.trim(), lastName: last.trim(), phone: phone.trim() });
    if (!created.ok) {
      setBusy(false);
      setError('יצירת הלקוח נכשלה — בדקו את הטלפון (ייתכן שכבר קיים).');
      return;
    }
    setBusy(false);
    await add(created.data.customer.id, created.data.customer.firstName);
  };

  const inputStyle: CSSProperties = {
    padding: '8px 10px',
    borderRadius: 9,
    border: '1.5px solid #e9e0d9',
    fontSize: 13.5,
    width: '100%',
    boxSizing: 'border-box',
  };
  const chip: CSSProperties = {
    border: '1.5px solid #e9e0d9',
    background: '#fff',
    borderRadius: 8,
    padding: '5px 10px',
    fontSize: 12.5,
    fontWeight: 600,
    color: MUTED,
    cursor: 'pointer',
  };

  return (
    <div style={{ border: '1px solid #e7d9c8', borderRadius: 10, padding: 10, background: '#fffdf9', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>
          {creating ? 'לקוח חדש' : 'הוספת משתתף — חיפוש לקוח'}
        </span>
        <button type="button" style={chip} onClick={() => { setCreating(!creating); setError(null); }}>
          {creating ? 'חזרה לחיפוש' : 'לקוח חדש'}
        </button>
      </div>

      {error && <div style={{ fontSize: 12.5, color: '#a23a3a', marginBottom: 8 }}>{error}</div>}

      {creating ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input placeholder="שם פרטי" value={first} onChange={(e) => setFirst(e.target.value)} style={inputStyle} />
            <input placeholder="שם משפחה" value={last} onChange={(e) => setLast(e.target.value)} style={inputStyle} />
          </div>
          <input placeholder="טלפון" value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} inputMode="tel" />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              disabled={busy || !first.trim() || !phone.trim()}
              onClick={() => void quickAdd()}
              style={{ border: 'none', background: ORANGE, color: '#fff', borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !first.trim() || !phone.trim() ? 0.5 : 1 }}
            >
              {busy ? 'מוסיף…' : 'יצירה והוספה'}
            </button>
            <button type="button" disabled={busy} onClick={onCancel} style={chip}>ביטול</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Fast cash path first — one tap, no info. The counter reaches for
              this most; searching a known customer sits below it. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => void addAnonymous()}
            style={{
              border: 'none',
              background: ORANGE,
              color: '#fff',
              borderRadius: 10,
              padding: '11px 14px',
              fontSize: 13.5,
              fontWeight: 700,
              cursor: 'pointer',
              width: '100%',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'מוסיף…' : 'כניסה במקום · מזומן — ללא פרטים'}
          </button>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: MUTED,
              fontSize: 11.5,
              margin: '2px 0',
            }}
          >
            <span style={{ flex: 1, height: 1, background: '#eee6dd' }} />
            או חפשו לקוח קיים
            <span style={{ flex: 1, height: 1, background: '#eee6dd' }} />
          </div>
          <input placeholder="שם, טלפון או מספר לקוח…" value={q} onChange={(e) => setQ(e.target.value)} style={inputStyle} />
          {searching && <div style={{ fontSize: 12.5, color: MUTED }}>מחפש…</div>}
          {!searching && q.trim().length >= 2 && results.length === 0 && (
            <div style={{ fontSize: 12.5, color: MUTED }}>לא נמצאו לקוחות. אפשר ליצור לקוח חדש למעלה.</div>
          )}
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              onClick={() => void add(c.id, c.firstName)}
              style={{ ...chip, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'right' }}
            >
              <span style={{ fontWeight: 600, color: INK }}>{c.firstName} {c.lastName}</span>
              <span style={{ color: MUTED, fontSize: 11.5 }} dir="ltr">{c.phone} · {c.customerNumber}</span>
            </button>
          ))}
          <button type="button" disabled={busy} onClick={onCancel} style={{ ...chip, alignSelf: 'flex-start' }}>ביטול</button>
        </div>
      )}
    </div>
  );
}
