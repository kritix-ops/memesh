import { boolean, integer, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tickets } from './tickets';
import { users } from './users';

export const redemptionMethodEnum = pgEnum('redemption_method', [
  'qr_scan',
  'serial',
  'phone_lookup',
  'manual',
]);

export const redemptions = pgTable('redemptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id),
  redeemedBy: uuid('redeemed_by')
    .notNull()
    .references(() => users.id),
  posTerminalId: varchar('pos_terminal_id', { length: 64 }),
  method: redemptionMethodEnum('method').notNull(),
  companionCount: integer('companion_count').notNull().default(1),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull().defaultNow(),
  isOfflineSync: boolean('is_offline_sync').notNull().default(false),
});

export type Redemption = typeof redemptions.$inferSelect;
export type NewRedemption = typeof redemptions.$inferInsert;
