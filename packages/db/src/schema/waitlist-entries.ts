import {
  index,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { roundInstances } from './round-instances';
import { ticketTypeEnum } from './rounds';

// Waitlist row's lifecycle:
//   waiting   — registered, hasn't been offered a spot yet
//   notified  — slot freed, customer has `claim_expires_at` to grab it
//   claimed   — customer accepted, went through the normal hold flow
//   expired   — claim window passed without acceptance; next-in-line is offered
//   cancelled — customer self-cancelled, OR admin removed
export const waitlistStatusEnum = pgEnum('waitlist_status', [
  'waiting',
  'notified',
  'claimed',
  'expired',
  'cancelled',
]);

// FIFO list of customers waiting for a slot in a full round_instance.
// Triggered by any slot release (booking cancellation, swap-out, hold
// expiry). Quiet-hours logic (08:00-22:00 default) defers notifications
// out of band — see super-brief §8.
export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundInstanceId: uuid('round_instance_id')
      .notNull()
      .references(() => roundInstances.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    requestedType: ticketTypeEnum('requested_type').notNull(),
    requestedCompanions: smallint('requested_companions').notNull().default(0),
    status: waitlistStatusEnum('status').notNull().default('waiting'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    // Set when status transitions to 'notified'. Customer has until this
    // moment to claim before the next-in-line is offered.
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // FIFO lookup: "next waiting entry for round X" — covers the
    // ORDER BY created_at ASC LIMIT 1 query in on_slot_freed().
    index('waitlist_round_status_created_idx').on(
      table.roundInstanceId,
      table.status,
      table.createdAt,
    ),
  ],
);

export type WaitlistEntry = typeof waitlistEntries.$inferSelect;
export type NewWaitlistEntry = typeof waitlistEntries.$inferInsert;
