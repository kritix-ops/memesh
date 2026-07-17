import { integer, pgEnum, pgTable, smallint, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { roundInstances } from './round-instances';

// Which kind of round reminder a log row records:
//   'stay'     — the in-visit "your round ends in N minutes" ping (super-brief §9)
//   'previsit' — the before-the-visit "see you tomorrow" reminder (Yanay #11)
// The kind is part of the idempotency key so a pre-visit offset can share a
// numeric value with a stay-duration offset without the two colliding.
export const reminderKindEnum = pgEnum('reminder_kind', ['stay', 'previsit']);

// One row per (round_instance, kind, offset) reminder that has been sent. The
// UNIQUE constraint is the idempotency guard: the reminder cron claims a
// reminder by inserting here ON CONFLICT DO NOTHING, so a re-run — or two
// overlapping runs — sends each (kind, offset) exactly once.
export const roundReminderLog = pgTable(
  'round_reminder_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundInstanceId: uuid('round_instance_id')
      .notNull()
      .references(() => roundInstances.id),
    kind: reminderKindEnum('kind').notNull().default('stay'),
    offsetMinutes: smallint('offset_minutes').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    recipientCount: integer('recipient_count').notNull().default(0),
  },
  (table) => [
    unique('round_reminder_once').on(table.roundInstanceId, table.kind, table.offsetMinutes),
  ],
);

export type RoundReminderLog = typeof roundReminderLog.$inferSelect;
