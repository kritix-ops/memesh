import {
  type AnyPgColumn,
  boolean,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const ticketTypeEnum = pgEnum('ticket_type', [
  'baby_single',
  'child_single',
  'companion',
  'punch_card',
]);

export const ticketSourceEnum = pgEnum('ticket_source', ['online', 'pos', 'manual']);

export const tickets = pgTable('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  ticketType: ticketTypeEnum('ticket_type').notNull(),
  qrToken: varchar('qr_token', { length: 512 }).notNull().unique(),
  serialNumber: varchar('serial_number', { length: 32 }).notNull().unique(),
  totalEntries: integer('total_entries'),
  usedEntries: integer('used_entries').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  wcOrderId: varchar('wc_order_id', { length: 64 }),
  wcProductId: integer('wc_product_id'),
  companionTicketId: uuid('companion_ticket_id').references((): AnyPgColumn => tickets.id),
  source: ticketSourceEnum('source').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
