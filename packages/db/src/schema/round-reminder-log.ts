import { integer, pgTable, smallint, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { roundInstances } from './round-instances';

// One row per (round_instance, offset) reminder that has been sent (super-brief
// §9). The UNIQUE constraint is the idempotency guard: the reminder cron claims
// a reminder by inserting here ON CONFLICT DO NOTHING, so a re-run — or two
// overlapping runs — sends each offset exactly once.
export const roundReminderLog = pgTable(
  'round_reminder_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundInstanceId: uuid('round_instance_id')
      .notNull()
      .references(() => roundInstances.id),
    offsetMinutes: smallint('offset_minutes').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    recipientCount: integer('recipient_count').notNull().default(0),
  },
  (table) => [unique('round_reminder_once').on(table.roundInstanceId, table.offsetMinutes)],
);

export type RoundReminderLog = typeof roundReminderLog.$inferSelect;
