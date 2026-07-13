// Stay-duration reminders (super-brief §9). A round is a fixed window, so the
// reminder is based on the round's END time and goes to every confirmed booking
// in it (a batch), at admin-configured offsets before the end (default 30 and
// 10 minutes). The last round of the day is skipped — the place is closing, so
// an "almost done" ping is just noise.
//
// This module only DECIDES + CLAIMS which reminders are due right now; the cron
// layer does the actual SMS/email send. Claiming (insert into round_reminder_log
// ON CONFLICT DO NOTHING) is the idempotency guard, so each (round, offset) fires
// exactly once even across overlapping cron runs.

import { and, eq, ne } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getRoundSettings } from './round-settings';
import { roundStartWallMs, venueTodayIso, venueWallMs } from './round-time';
import { bookings, customers, roundInstances, roundReminderLog, rounds } from './schema/index';
import { WALKIN_SENTINEL_PHONE } from './walkin-customer';

type AnyPgDatabase = PgDatabase<any, any, any>;

// A reminder is "due" for a short window after its send time, so a per-minute
// cron catches it even with a little jitter; the claim keeps it to one send.
const DUE_WINDOW_MS = 90_000;

export interface ReminderRecipient {
  firstName: string;
  phone: string;
  email: string | null;
}

export interface DueReminder {
  roundInstanceId: string;
  offsetMinutes: number;
  roundLabel: string;
  startTime: string;
  endTime: string;
  date: string;
  recipients: ReminderRecipient[];
}

const hhmm = (t: string): string => t.slice(0, 5);

/**
 * Find, claim, and return the stay-duration reminders due at `now`, each with
 * its confirmed-booking recipients. Claims inside a per-(round, offset) unique
 * insert so a re-run doesn't double-send. Returns an empty list when reminders
 * are disabled (no offsets) or nothing is due.
 */
export const claimDueReminders = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
): Promise<DueReminder[]> => {
  const settings = await getRoundSettings(db);
  if (settings.reminderOffsets.length === 0) return [];

  const nowWall = venueWallMs(now);
  const todayIso = venueTodayIso(now);

  const instances = await db
    .select({
      id: roundInstances.id,
      date: roundInstances.date,
      label: rounds.displayName,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
    })
    .from(roundInstances)
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(and(eq(roundInstances.date, todayIso), eq(roundInstances.isClosed, false)));
  if (instances.length === 0) return [];

  // The last round of the day = the latest end_time among today's active rounds.
  const maxEnd = instances.reduce((m, i) => (i.endTime > m ? i.endTime : m), '00:00:00');

  const due: DueReminder[] = [];
  for (const inst of instances) {
    if (settings.skipLastRoundReminder && inst.endTime === maxEnd) continue;
    const endWall = roundStartWallMs(inst.date, hhmm(inst.endTime));
    for (const offset of settings.reminderOffsets) {
      const delta = nowWall - (endWall - offset * 60_000);
      if (delta < 0 || delta >= DUE_WINDOW_MS) continue; // not due this tick

      // Claim: first writer for this (round, offset) wins; the rest skip.
      const claimed = await db
        .insert(roundReminderLog)
        .values({ roundInstanceId: inst.id, offsetMinutes: offset, sentAt: now })
        .onConflictDoNothing()
        .returning({ id: roundReminderLog.id });
      if (claimed.length === 0) continue;

      const recipients = await db
        .select({ firstName: customers.firstName, phone: customers.phone, email: customers.email })
        .from(bookings)
        .innerJoin(customers, eq(customers.id, bookings.customerId))
        // Anonymous cash walk-ins book under the sentinel customer, which has a
        // placeholder phone — never hand it to the SMS cron.
        .where(
          and(
            eq(bookings.roundInstanceId, inst.id),
            eq(bookings.status, 'confirmed'),
            ne(customers.phone, WALKIN_SENTINEL_PHONE),
          ),
        );

      await db
        .update(roundReminderLog)
        .set({ recipientCount: recipients.length })
        .where(
          and(
            eq(roundReminderLog.roundInstanceId, inst.id),
            eq(roundReminderLog.offsetMinutes, offset),
          ),
        );

      due.push({
        roundInstanceId: inst.id,
        offsetMinutes: offset,
        roundLabel: inst.label,
        startTime: hhmm(inst.startTime),
        endTime: hhmm(inst.endTime),
        date: inst.date,
        recipients,
      });
    }
  }
  return due;
};
