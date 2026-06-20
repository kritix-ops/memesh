import { integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { staff } from './staff';

// One attribution PIN per cashier. Used at the till on every sale to stamp
// `sold_by` on the resulting punch card. The PIN does NOT replace phone+
// password staff login — the device is already authenticated; this just says
// "which staff member at this register did this sale." We store a scrypt
// hash peppered with SERVER_SECRET_KEY so a DB leak does not reveal active
// PINs even though the entropy is only 3 digits by default.
//
// PIN collisions between cashiers are allowed by design: with 1000 codes and
// a small staff, two cashiers may pick the same one. What matters is who is
// authenticated at the device; the lookup is per-staff, never "which staff
// has PIN 123".
export const staffPins = pgTable('staff_pins', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id')
    .notNull()
    .unique()
    .references(() => staff.id, { onDelete: 'cascade' }),
  pinHash: varchar('pin_hash', { length: 255 }).notNull(),
  failedCount: integer('failed_count').notNull().default(0),
  // null = not locked. Set to `now + pin_lockout_minutes` after the
  // configured number of consecutive wrong tries.
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type StaffPin = typeof staffPins.$inferSelect;
export type NewStaffPin = typeof staffPins.$inferInsert;
