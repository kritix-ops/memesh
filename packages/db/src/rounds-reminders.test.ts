import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCustomer } from './cards';
import { claimDueReminders } from './rounds-reminders';
import { createRound } from './rounds';
import { updateRoundSettings } from './round-settings';
import { bookings, roundInstances } from './schema';

async function freshDb() {
  const db = drizzle({ client: new PGlite() });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

// Absolute instant → venue 17:30 (Jerusalem is UTC+3 in July). A round ending
// 18:00 is then exactly at its 30-minute offset; the default offsets are [30,10].
const NOW = new Date('2026-07-01T14:30:00Z');
const DATE = '2026-07-01';
let phoneSeq = 900;
const phone = () => `05000000${(phoneSeq += 1)}`;

async function instanceFor(db: Awaited<ReturnType<typeof freshDb>>, roundId: string): Promise<string> {
  const row = (
    await db.select().from(roundInstances).where(and(eq(roundInstances.roundId, roundId), eq(roundInstances.date, DATE))).limit(1)
  )[0];
  if (!row) throw new Error('no instance for today');
  return row.id;
}

async function confirmedBooking(db: Awaited<ReturnType<typeof freshDb>>, instanceId: string, token: string) {
  const cust = await createCustomer(db, { firstName: 'א', lastName: 'ב', phone: phone() });
  await db.insert(bookings).values({ roundInstanceId: instanceId, customerId: cust.id, ticketType: 'child_over_walking', source: 'paid', status: 'confirmed', confirmedAt: NOW, barcodeToken: token });
  return cust.id;
}

test('claimDueReminders offers a due reminder to the confirmed bookings of a non-last round', async () => {
  const db = await freshDb();
  const a = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 30 }, NOW);
  await createRound(db, { label: 'b', displayName: 'B', startTime: '18:00', endTime: '20:00', daysActive: 127, defaultCapacity: 30 }, NOW);
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id);
  await confirmedBooking(db, instA, 'rem-a-1');
  // A cancelled booking must NOT be a recipient.
  const cx = await createCustomer(db, { firstName: 'ג', lastName: 'ד', phone: phone() });
  await db.insert(bookings).values({ roundInstanceId: instA, customerId: cx.id, ticketType: 'child_over_walking', source: 'paid', status: 'cancelled', barcodeToken: 'rem-a-x' });

  const due = await claimDueReminders(db, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.roundInstanceId, instA);
  assert.equal(due[0]!.offsetMinutes, 30);
  assert.equal(due[0]!.recipients.length, 1); // confirmed only
});

test('claimDueReminders does not resend a reminder it already claimed', async () => {
  const db = await freshDb();
  const a = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 30 }, NOW);
  await createRound(db, { label: 'b', displayName: 'B', startTime: '18:00', endTime: '20:00', daysActive: 127, defaultCapacity: 30 }, NOW);
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
  const a = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 30 }, NOW);
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
  const a = await createRound(db, { label: 'a', displayName: 'A', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 30 }, NOW);
  await createRound(db, { label: 'b', displayName: 'B', startTime: '18:00', endTime: '20:00', daysActive: 127, defaultCapacity: 30 }, NOW);
  if (!a.ok) throw new Error('round');
  const instA = await instanceFor(db, a.round.id);
  await confirmedBooking(db, instA, 'rem-d-1');

  const due = await claimDueReminders(db, NOW);
  assert.equal(due.length, 0);
});
