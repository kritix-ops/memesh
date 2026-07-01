// Wall-clock time math for the round timing gates, computed in the venue
// timezone (Asia/Jerusalem). The swap gate ("until the round starts") and the
// cancel gate ("up to N hours before start") both compare `now` to a round's
// start as WALL times. Each wall time is expressed as the epoch-ms of that wall
// time treated as UTC, so the fixed offset cancels in a difference — correct
// except within a DST-transition hour (±1h), which we accept for v1 (a booking
// isn't cancelled/swapped to the exact minute).

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

/** True while `now` is at least `windowHours` before the round's start (the cancel window). */
export function isWithinCancelWindow(
  dateIso: string,
  startTimeHhmm: string,
  windowHours: number,
  now: Date,
): boolean {
  return roundStartWallMs(dateIso, startTimeHhmm) - venueWallMs(now) >= windowHours * 3_600_000;
}
