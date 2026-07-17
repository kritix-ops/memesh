import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { claimDuePreVisitReminders, claimDueReminders } from './rounds-reminders';
import { createRound } from './rounds';
import { updateRoundSettings } from './round-settings';
import { bookings, roundInstances, roundReminderLog } from './schema';
import { getOrCreateWalkInCustomerId } from './walkin-customer';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

// Absolute instant → venue 17:30 (Jerusalem is UTC+3 in July). A round ending
// 18:00 is then exactly at its 30-minute offset; the default offsets are [30,10].
const NOW = new Date('2026-07-01T14:30:00Z');
const DATE = '2026-07-01';
// Venue "now" is 17:30 today, so a round starting 17:30 TOMORROW is exactly the
// default pre-visit offset (1440 min = 24h) ahead — the "מחכים לכם מחר" case.
const TOMORROW = '2026-07-02';
let phoneSeq = 900;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function instanceFor(
  db: Awaited<ReturnType<typeof freshDb>>,
  roundId: string,
): Promise<string> {
  return instanceForDate(db, roundId, DATE);
}

async function instanceForDate(
  db: Awaited<ReturnType<typeof freshDb>>,
  roundId: string,
  date: string,
): Promise<string> {
  const row = (
    await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, date)))
      .limit(1)
  )[0];
  if (!row) throw new Error(`no instance for ${date}`);
  return row.id;
}

async function confirmedBooking(
  db: Awaited<ReturnType<typeof freshDb>>,
  instanceId: string,
  token: string,
) {
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  await db
    .insert(bookings)
    .values({
      roundInstanceId: instanceId,
      customerId: cust.id,
      ticketType: 'child_over_walking',
      source: 'paid',
      status: 'confirmed',
      confirmedAt: NOW,
      barcodeToken: token,
    });
  return cust.id;
}

test('claimDueReminders offers a due reminder to the confirmed bookings of a non-last round', async () => {
  const db = await freshDb();
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'A',
      startTime: '16:00',
      endTime: '18:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  await createRound(
    db,
    {
      label: 'b',
      displayName: 'B',
      startTime: '18:00',
      endTime: '20:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id);
  await confirmedBooking(db, instA, 'rem-a-1');
  // A cancelled booking must NOT be a recipient.
  const cx = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });
  await db
    .insert(bookings)
    .values({
      roundInstanceId: instA,
      customerId: cx.id,
      ticketType: 'child_over_walking',
      source: 'paid',
      status: 'cancelled',
      barcodeToken: 'rem-a-x',
    });

  const due = await claimDueReminders(db, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.roundInstanceId, instA);
  assert.equal(due[0]!.offsetMinutes, 30);
  assert.equal(due[0]!.recipients.length, 1); // confirmed only
});

test('claimDueReminders excludes the anonymous walk-in sentinel from recipients', async () => {
  const db = await freshDb();
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'A',
      startTime: '16:00',
      endTime: '18:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  await createRound(
    db,
    {
      label: 'b',
      displayName: 'B',
      startTime: '18:00',
      endTime: '20:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id);
  await confirmedBooking(db, instA, 'rem-anon-1'); // a real customer → a recipient
  // An anonymous cash walk-in books under the sentinel (placeholder phone) —
  // it must never be handed to the SMS cron.
  const sentinelId = await getOrCreateWalkInCustomerId(db);
  await db
    .insert(bookings)
    .values({
      roundInstanceId: instA,
      customerId: sentinelId,
      ticketType: 'child_over_walking',
      source: 'manual',
      status: 'confirmed',
      confirmedAt: NOW,
      barcodeToken: 'rem-anon-2',
    });

  const due = await claimDueReminders(db, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.recipients.length, 1); // only the real customer, sentinel excluded
});

test('claimDueReminders does not resend a reminder it already claimed', async () => {
  const db = await freshDb();
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'A',
      startTime: '16:00',
      endTime: '18:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  await createRound(
    db,
    {
      label: 'b',
      displayName: 'B',
      startTime: '18:00',
      endTime: '20:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id);
  await confirmedBooking(db, instA, 'rem-i-1');

  const first = await claimDueReminders(db, NOW);
  assert.equal(first.length, 1);
  const second = await claimDueReminders(db, NOW);
  assert.equal(second.length, 0);
});

test('claimDueReminders skips the last round of the day, unless disabled', async () => {
  const db = await freshDb();
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'A',
      startTime: '16:00',
      endTime: '18:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id); // the only round → the last one
  await confirmedBooking(db, instA, 'rem-l-1');

  const skipped = await claimDueReminders(db, NOW);
  assert.equal(skipped.length, 0);

  await updateRoundSettings(db, { skipLastRoundReminder: false });
  const due = await claimDueReminders(db, NOW);
  assert.equal(due.length, 1);
});

test('claimDueReminders returns nothing when reminders are disabled (no offsets)', async () => {
  const db = await freshDb();
  await updateRoundSettings(db, { reminderOffsets: [] });
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'A',
      startTime: '16:00',
      endTime: '18:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  await createRound(
    db,
    {
      label: 'b',
      displayName: 'B',
      startTime: '18:00',
      endTime: '20:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id);
  await confirmedBooking(db, instA, 'rem-d-1');

  const due = await claimDueReminders(db, NOW);
  assert.equal(due.length, 0);
});

test('a reminder counts one recipient per person, not per booking (sibling dedupe)', async () => {
  const db = await freshDb();
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'A',
      startTime: '16:00',
      endTime: '18:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  await createRound(
    db,
    {
      label: 'b',
      displayName: 'B',
      startTime: '18:00',
      endTime: '20:00',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id);
  // One parent, two children in the same round = two bookings, one phone.
  const parent = await createCustomer(db, { firstName: 'הורה', lastName: 'ב', phone: phone() });
  for (const token of ['sib-1', 'sib-2']) {
    await db
      .insert(bookings)
      .values({
        roundInstanceId: instA,
        customerId: parent.id,
        ticketType: 'child_over_walking',
        source: 'punchcard',
        status: 'confirmed',
        confirmedAt: NOW,
        barcodeToken: token,
      });
  }

  const due = await claimDueReminders(db, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.recipients.length, 1); // one message to the parent, not two
});

test('claimDuePreVisitReminders offers a reminder 24h before the round starts', async () => {
  const db = await freshDb();
  // A round starting 17:30 has a TOMORROW instance exactly 1440 min ahead of NOW.
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'סבב בוקר',
      startTime: '17:30',
      endTime: '19:30',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instTomorrow = await instanceForDate(db, a.round.id, TOMORROW);
  await confirmedBooking(db, instTomorrow, 'pv-1');
  // Today's instance of the same round is only hours away — not 24h — so it must
  // NOT fire: proves the claim is keyed off start, and today's round is ignored.
  const instToday = await instanceForDate(db, a.round.id, DATE);
  await confirmedBooking(db, instToday, 'pv-today');

  const due = await claimDuePreVisitReminders(db, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.roundInstanceId, instTomorrow);
  assert.equal(due[0]!.offsetMinutes, 1440);
  assert.equal(due[0]!.recipients.length, 1);
});

test('claimDuePreVisitReminders does not resend, and turns off with no offsets', async () => {
  const db = await freshDb();
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'A',
      startTime: '17:30',
      endTime: '19:30',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instTomorrow = await instanceForDate(db, a.round.id, TOMORROW);
  await confirmedBooking(db, instTomorrow, 'pv-i-1');

  const first = await claimDuePreVisitReminders(db, NOW);
  assert.equal(first.length, 1);
  const second = await claimDuePreVisitReminders(db, NOW);
  assert.equal(second.length, 0); // idempotent — the kind='previsit' claim already fired

  await updateRoundSettings(db, { preVisitReminderOffsets: [] });
  const disabled = await claimDuePreVisitReminders(db, NOW);
  assert.equal(disabled.length, 0);
});

test('a stay-duration log row does not block a pre-visit claim at the same offset', async () => {
  const db = await freshDb();
  const a = await createRound(
    db,
    {
      label: 'a',
      displayName: 'A',
      startTime: '17:30',
      endTime: '19:30',
      daysActive: 127,
      defaultCapacity: 30,
    },
    NOW,
  );
  if (!a.ok) throw new Error('round');
  const instTomorrow = await instanceForDate(db, a.round.id, TOMORROW);
  await confirmedBooking(db, instTomorrow, 'kind-pv');
  // Pre-empt the log with a 'stay' row at offset 1440 on the SAME round. Because
  // kind is part of the idempotency key, the pre-visit claim must still fire.
  await db
    .insert(roundReminderLog)
    .values({ roundInstanceId: instTomorrow, kind: 'stay', offsetMinutes: 1440 });

  const due = await claimDuePreVisitReminders(db, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.offsetMinutes, 1440);
});
