// Schedule-rules engine (plan 2026-07-02-round-schedule-rules): validation,
// date matching, specificity resolution, fit-entirely window matching, and
// the booking-path guards (hold + punch refuse rounds a rule filters out).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer, createPunchCard } from './cards';
import { updateRoundSettings } from './round-settings';
import { createHold } from './rounds-hold';
import { bookRoundWithPunch } from './rounds-punch';
import {
  createScheduleRule,
  deleteScheduleRule,
  isInstanceSchedulable,
  listScheduleRules,
  resolveScheduleForDate,
  roundFitsWindows,
  validateScheduleRule,
} from './rounds-schedule';
import { createRound } from './rounds';
import { roundInstances } from './schema';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

const SECRET = 'a-schedule-secret-at-least-32-chars!';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (id) => (id === '1' ? SECRET : undefined),
};

const NOW = new Date(2026, 6, 1, 12, 0, 0);
// 2026-07-10 is a Friday (weekday 5), 2026-07-11 a Saturday.
const FRIDAY = '2026-07-10';
const SATURDAY = '2026-07-11';
let phoneSeq = 900;
const phone = () => `05000000${(phoneSeq += 1)}`;

// --- validation (pure) --------------------------------------------------------

test('validate: scope required, ranges ordered, mask bounded', () => {
  assert.equal(validateScheduleRule({ windows: [], outside: 'free_play' })?.code, 'scope_required');
  assert.equal(
    validateScheduleRule({ dateTo: '2026-07-10', windows: [], outside: 'free_play' })?.code,
    'scope_required',
  );
  assert.equal(
    validateScheduleRule({ dateFrom: '2026-07-10', dateTo: '2026-07-01', windows: [], outside: 'closed' })?.code,
    'date_range_inverted',
  );
  assert.equal(
    validateScheduleRule({ weekdayMask: 0, windows: [], outside: 'free_play' })?.code,
    'weekday_mask_out_of_range',
  );
  assert.equal(
    validateScheduleRule({ weekdayMask: 128, windows: [], outside: 'free_play' })?.code,
    'weekday_mask_out_of_range',
  );
  assert.equal(validateScheduleRule({ dateFrom: '2026-07-10', windows: [], outside: 'free_play' }), null);
});

test('validate: window times, ordering, overlap', () => {
  const base = { dateFrom: FRIDAY, outside: 'free_play' as const };
  assert.equal(
    validateScheduleRule({ ...base, windows: [{ start: '25:00', end: '26:00' }] })?.code,
    'window_time_invalid',
  );
  assert.equal(
    validateScheduleRule({ ...base, windows: [{ start: '14:00', end: '14:00' }] })?.code,
    'window_end_not_after_start',
  );
  assert.equal(
    validateScheduleRule({
      ...base,
      windows: [
        { start: '14:00', end: '16:00' },
        { start: '15:00', end: '17:00' },
      ],
    })?.code,
    'windows_overlap',
  );
  assert.equal(
    validateScheduleRule({
      ...base,
      windows: [
        { start: '18:00', end: '19:00' },
        { start: '14:00', end: '16:00' },
      ],
    }),
    null, // unsorted input is fine — validation sorts before the overlap check
  );
});

// --- fit matcher (pure) --------------------------------------------------------

test('roundFitsWindows: entire fit only, HH:MM:SS tolerated', () => {
  const windows = [
    { start: '14:00', end: '16:00' },
    { start: '18:00', end: '19:00' },
  ];
  assert.equal(roundFitsWindows('14:00:00', '16:00:00', windows), true);
  assert.equal(roundFitsWindows('14:30', '15:30', windows), true);
  assert.equal(roundFitsWindows('15:00', '17:00', windows), false); // spills out
  assert.equal(roundFitsWindows('13:00', '14:30', windows), false);
  assert.equal(roundFitsWindows('18:00', '19:00', windows), true);
  assert.equal(roundFitsWindows('10:00', '11:00', [])/* no windows */, false);
});

// --- matching + specificity ----------------------------------------------------

test('resolve: single date beats range beats recurring; ties go to newest', async () => {
  const db = await freshDb();
  const mk = (input: Parameters<typeof createScheduleRule>[1], at: Date) =>
    createScheduleRule(db, input, at);

  // Recurring: Fridays closed all day.
  await mk({ weekdayMask: 1 << 5, windows: [], outside: 'closed' }, new Date(2026, 5, 1));
  // Range covering the date: free play all day.
  await mk(
    { dateFrom: '2026-07-05', dateTo: '2026-07-20', windows: [], outside: 'free_play' },
    new Date(2026, 5, 2),
  );
  // Single date: rounds 14:00-16:00, closed outside.
  await mk(
    { dateFrom: FRIDAY, dateTo: FRIDAY, windows: [{ start: '14:00', end: '16:00' }], outside: 'closed' },
    new Date(2026, 5, 3),
  );

  const winner = await resolveScheduleForDate(db, FRIDAY);
  assert.equal(winner?.outside, 'closed');
  assert.deepEqual(winner?.windows, [{ start: '14:00', end: '16:00' }]);

  // A Saturday inside the range: range rule wins (recurring rule is Friday-only).
  const sat = await resolveScheduleForDate(db, SATURDAY);
  assert.equal(sat?.outside, 'free_play');
  assert.deepEqual(sat?.windows, []);

  // A Friday outside the range: recurring rule wins.
  const laterFriday = await resolveScheduleForDate(db, '2026-07-24');
  assert.equal(laterFriday?.outside, 'closed');
  assert.deepEqual(laterFriday?.windows, []);

  // A date matching nothing: null (default behavior).
  assert.equal(await resolveScheduleForDate(db, '2026-07-22'), null); // Wednesday, outside range
});

test('resolve: weekday-in-range matches only that weekday inside the range; open-ended from-date works', async () => {
  const db = await freshDb();
  await createScheduleRule(db, {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    weekdayMask: 1 << 5, // Fridays in July
    windows: [{ start: '10:00', end: '13:00' }],
    outside: 'free_play',
  });
  assert.notEqual(await resolveScheduleForDate(db, FRIDAY), null);
  assert.equal(await resolveScheduleForDate(db, SATURDAY), null);
  assert.equal(await resolveScheduleForDate(db, '2026-08-07'), null); // Friday past the range

  // Open-ended: Saturdays from Aug 1 onward, no rounds.
  await createScheduleRule(db, {
    dateFrom: '2026-08-01',
    weekdayMask: 1 << 6,
    windows: [],
    outside: 'free_play',
  });
  assert.notEqual(await resolveScheduleForDate(db, '2026-08-08'), null); // Saturday after
  assert.equal(await resolveScheduleForDate(db, SATURDAY), null); // Saturday before from-date
});

test('CRUD: list ordered, delete removes, unknown delete reports not-ok', async () => {
  const db = await freshDb();
  const a = await createScheduleRule(db, { dateFrom: FRIDAY, windows: [], outside: 'free_play' });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal((await listScheduleRules(db)).length, 1);
  assert.equal((await deleteScheduleRule(db, a.rule.id)).ok, true);
  assert.equal((await listScheduleRules(db)).length, 0);
  assert.equal((await deleteScheduleRule(db, a.rule.id)).ok, false);
});

// --- booking-path guards --------------------------------------------------------

async function roundOn(db: Awaited<ReturnType<typeof freshDb>>, start: string, end: string) {
  const r = await createRound(
    db,
    { label: `r${start}`, displayName: `סבב ${start}`, startTime: start, endTime: end, daysActive: 127, defaultCapacity: 5 },
    NOW,
  );
  if (!r.ok) throw new Error('round');
  const inst = (
    await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, r.round.id), eq(roundInstances.date, FRIDAY)))
      .limit(1)
  )[0];
  if (!inst) throw new Error('instance');
  return inst.id;
}

test('booking horizon: a date beyond the window is not schedulable', async () => {
  const db = await freshDb();
  const inst = await roundOn(db, '14:00', '16:00'); // on FRIDAY (2026-07-10)

  // From NOW (2026-07-01) FRIDAY is 9 days out: inside a 30-day horizon, outside 5.
  assert.equal((await isInstanceSchedulable(db, inst, { now: NOW, bookingHorizonDays: 30 })).ok, true);
  const tight = await isInstanceSchedulable(db, inst, { now: NOW, bookingHorizonDays: 5 });
  assert.equal(tight.ok, false);
  if (!tight.ok) assert.equal(tight.reason, 'beyond_horizon');

  // Omitting the horizon skips the check (schedule-only callers stay unaffected).
  assert.equal((await isInstanceSchedulable(db, inst)).ok, true);
});

test('guards: a rule filters holds and punch bookings for non-fitting rounds', async () => {
  const db = await freshDb();
  const fitting = await roundOn(db, '14:00', '16:00');
  const filtered = await roundOn(db, '16:00', '18:00');
  await createScheduleRule(db, {
    dateFrom: FRIDAY,
    dateTo: FRIDAY,
    windows: [{ start: '14:00', end: '16:00' }],
    outside: 'free_play',
  });
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });

  assert.equal((await isInstanceSchedulable(db, fitting)).ok, true);
  assert.equal((await isInstanceSchedulable(db, filtered)).ok, false);

  const okHold = await createHold(db, { roundInstanceId: fitting, customerId: cust.id, ticketType: 'child_over_walking' }, NOW);
  assert.equal(okHold.ok, true);
  const badHold = await createHold(db, { roundInstanceId: filtered, customerId: cust.id, ticketType: 'child_over_walking' }, NOW);
  assert.equal(badHold.ok, false);
  if (!badHold.ok) assert.equal(badHold.error, 'closed');

  const card = await createPunchCard(db, resolver, { customerId: cust.id, totalEntries: 12, validityDays: 0, now: NOW });
  const badPunch = await bookRoundWithPunch(
    db,
    { roundInstanceId: filtered, customerId: cust.id, punchCardId: card.id, ticketType: 'child_over_walking' },
    resolver,
    NOW,
  );
  assert.equal(badPunch.ok, false);
  if (!badPunch.ok) assert.equal(badPunch.error, 'round_closed');
  const okPunch = await bookRoundWithPunch(
    db,
    { roundInstanceId: fitting, customerId: cust.id, punchCardId: card.id, ticketType: 'child_over_walking' },
    resolver,
    NOW,
  );
  assert.equal(okPunch.ok, true);
});

test('guards: the master switch off refuses holds and punch bookings everywhere', async () => {
  const db = await freshDb();
  const inst = await roundOn(db, '14:00', '16:00');
  await updateRoundSettings(db, { roundsEnabled: false });
  const cust = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });

  const hold = await createHold(db, { roundInstanceId: inst, customerId: cust.id, ticketType: 'child_over_walking' }, NOW);
  assert.equal(hold.ok, false);
  if (!hold.ok) assert.equal(hold.error, 'closed');

  const card = await createPunchCard(db, resolver, { customerId: cust.id, totalEntries: 12, validityDays: 0, now: NOW });
  const punch = await bookRoundWithPunch(
    db,
    { roundInstanceId: inst, customerId: cust.id, punchCardId: card.id, ticketType: 'child_over_walking' },
    resolver,
    NOW,
  );
  assert.equal(punch.ok, false);
  if (!punch.ok) assert.equal(punch.error, 'round_closed');
});
