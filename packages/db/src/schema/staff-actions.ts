import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { staff } from './staff';

// Append-only audit of notable staff actions, surfaced in the admin action log.
export const staffActions = pgTable('staff_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id').references(() => staff.id),
  action: varchar('action', { length: 40 }).notNull(), // cancel_card | sell_card | register_customer | ...
  summary: text('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type StaffActionRow = typeof staffActions.$inferSelect;
export type NewStaffActionRow = typeof staffActions.$inferInsert;
