import { desc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { staff, staffActions } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

export type StaffActionType =
  | 'punch'
  | 'sell_card'
  | 'cancel_card'
  | 'register_customer'
  | 'create_staff'
  | 'update_card_settings'
  | 'refund_entry'
  | 'reassign_card'
  | 'edit_card'
  | 'update_role_permission'
  | 'reset_role_permissions'
  | 'other';

export interface LogStaffActionInput {
  staffId?: string;
  action: StaffActionType;
  summary: string;
  now?: Date;
}

/** Append one entry to the staff action log. */
export const logStaffAction = async (db: AnyPgDatabase, input: LogStaffActionInput) => {
  const rows = await db
    .insert(staffActions)
    .values({
      staffId: input.staffId ?? null,
      action: input.action,
      summary: input.summary,
      ...(input.now ? { createdAt: input.now } : {}),
    })
    .returning({ id: staffActions.id });
  return rows[0];
};

/** Most recent staff actions with the acting member's name, for the admin log. */
export const listStaffActions = async (db: AnyPgDatabase, limit = 50) =>
  db
    .select({
      id: staffActions.id,
      action: staffActions.action,
      summary: staffActions.summary,
      createdAt: staffActions.createdAt,
      staffId: staffActions.staffId,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
    })
    .from(staffActions)
    .leftJoin(staff, eq(staff.id, staffActions.staffId))
    .orderBy(desc(staffActions.createdAt))
    .limit(limit);
