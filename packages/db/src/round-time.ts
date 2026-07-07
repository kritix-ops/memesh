// Wall-clock time math for the round timing gates, computed in the venue
// timezone (Asia/Jerusalem). The swap gate ("until the round starts") and the
// cancel gate ("up to N hours before start") both compare `now` to a round's
// start as WALL times. Each wall time is expressed as the epoch-ms of that wall
// time treated as UTC, so the fixed offset cancels in a difference — correct
// except within a DST-transition hour (±1h), which we accept for v1 (a booking
// isn't cancelled/swapped to the exact minute).
//
// The venue-calendar helpers below (venueTodayIso and friends) are the ONLY
// correct way to ask "what date is today" on the server: the host runs on UTC,
// so between 00:00 and 03:00 Israel time the server's local date is still
// yesterday (Yoav 2026-07-05 — the staff panel said "no rounds today" on a
// Sunday because it queried the server's Saturday).

const VENUE_TZ = 'Asia/Jerusalem';

/** `now` as venue wall-clock time, as epoch-ms of that wall time treated as UTC. */
export function venueWallMs(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VENUE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // Some environments emit hour '24' at midnight; normalize to 0.
  const hour = g('hour') % 24;
  return Date.UTC(g('year'), g('month') - 1, g('day'), hour, g('minute'), g('second'));
}

/** A round's start (date "YYYY-MM-DD" + "HH:MM") as epoch-ms of that wall time treated as UTC. */
export function roundStartWallMs(dateIso: string, startTimeHhmm: string): number {
  const y = Number(dateIso.slice(0, 4));
  const mo = Number(dateIso.slice(5, 7));
  const d = Number(dateIso.slice(8, 10));
  const h = Number(startTimeHhmm.slice(0, 2));
  const mi = Number(startTimeHhmm.slice(3, 5));
  return Date.UTC(y, mo - 1, d, h, mi);
}

/** True while `now` is before the round's start (the swap window). */
export function isBeforeRoundStart(dateIso: string, startTimeHhmm: string, now: Date): boolean {
  return roundStartWallMs(dateIso, startTimeHhmm) > venueWallMs(now);
}

/** True once the round's end time has passed — i.e. the round is over (venue
 *  wall clock). Symmetric to isBeforeRoundStart, using the end time. */
export function isRoundEnded(dateIso: string, endTimeHhmm: string, now: Date): boolean {
  return roundStartWallMs(dateIso, endTimeHhmm) <= venueWallMs(now);
}

/** True while `now` is at least `windowHours` before the round's start (the cancel window). */
export function isWithinCancelWindow(
  dateIso: string,
  startTimeHhmm: string,
  windowHours: number,
  now: Date,
): boolean {
  return roundStartWallMs(dateIso, startTimeHhmm) - venueWallMs(now) >= windowHours * 3_600_000;
}

/** The venue-local calendar date of `now`, as 'YYYY-MM-DD'. */
export function venueTodayIso(now: Date = new Date()): string {
  return new Date(venueWallMs(now)).toISOString().slice(0, 10);
}

/**
 * The instant the venue's current calendar day began (venue midnight). Uses the
 * venue's UTC offset at `now`, so within a DST-transition day it can be off by
 * ±1h — the same accepted convention as the gates above.
 */
export function venueStartOfDay(now: Date = new Date()): Date {
  // venueWallMs truncates to whole seconds; offsets are whole minutes, so round.
  const offsetMs = Math.round((venueWallMs(now) - now.getTime()) / 60_000) * 60_000;
  const dateIso = venueTodayIso(now);
  return new Date(roundStartWallMs(dateIso, '00:00') - offsetMs);
}

/** 'YYYY-MM-DD' plus `days` (may be negative). Pure calendar math, timezone-free. */
export function addIsoDays(dateIso: string, days: number): string {
  const y = Number(dateIso.slice(0, 4));
  const m = Number(dateIso.slice(5, 7));
  const d = Number(dateIso.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Weekday of an ISO date, 0 = Sunday … 6 = Saturday (matches the daysActive bitmask). */
export function isoWeekday(dateIso: string): number {
  return new Date(`${dateIso}T12:00:00Z`).getUTCDay();
}

/** The venue-local hour (0-23) of `now`. */
export function venueHour(now: Date): number {
  return new Date(venueWallMs(now)).getUTCHours();
}

/**
 * True when `now` (venue local) falls in [startHour, endHour) — the waitlist
 * active-notification window (super-brief §8.2). Handles an overnight window
 * (start > end) by treating it as wrapping past midnight.
 */
export function isWithinActiveHours(startHour: number, endHour: number, now: Date): boolean {
  const h = venueHour(now);
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}
