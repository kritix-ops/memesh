import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { type ChildRecord, customers, staff } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;
type StaffRole = 'admin' | 'manager' | 'cashier';

// Public view of a staff row: the password hash is never selected or returned.
const staffView = {
  id: staff.id,
  firstName: staff.firstName,
  lastName: staff.lastName,
  phone: staff.phone,
  email: staff.email,
  role: staff.role,
  isActive: staff.isActive,
  createdAt: staff.createdAt,
};

export interface CreateStaffInput {
  firstName: string;
  lastName: string;
  phone: string;
  passwordHash: string; // already hashed by the caller (api layer)
  role?: StaffRole;
  email?: string;
}

export const createStaff = async (db: AnyPgDatabase, input: CreateStaffInput) => {
  const rows = await db
    .insert(staff)
    .values({
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      passwordHash: input.passwordHash,
      role: input.role ?? 'cashier',
      ...(input.email !== undefined && { email: input.email }),
    })
    .returning(staffView);
  const row = rows[0];
  if (!row) throw new Error('[createStaff] insert returned no row');
  return row;
};

export const listStaff = async (db: AnyPgDatabase) => db.select(staffView).from(staff);

/**
 * Fetch the public profile for a single staff member by id. Returns undefined
 * if the row is missing. The password hash is never selected; this is the
 * shape /auth/me returns to a logged-in client.
 */
export const getStaffById = async (db: AnyPgDatabase, id: string) => {
  const rows = await db.select(staffView).from(staff).where(eq(staff.id, id)).limit(1);
  return rows[0];
};

export interface UpdateStaffInput {
  firstName?: string | undefined;
  lastName?: string | undefined;
  email?: string | null | undefined;
  role?: StaffRole | undefined;
  isActive?: boolean | undefined;
}

/**
 * Update a staff member's editable fields. Returns the updated public view
 * or undefined if the id is not found. Password is intentionally NOT editable
 * here — staff password resets need their own dedicated flow (admin sets a
 * new hash and the user is notified out of band).
 */
export const updateStaff = async (
  db: AnyPgDatabase,
  id: string,
  patch: UpdateStaffInput,
  now: Date = new Date(),
) => {
  const set: Partial<typeof staff.$inferInsert> = { updatedAt: now };
  if (patch.firstName !== undefined) set.firstName = patch.firstName;
  if (patch.lastName !== undefined) set.lastName = patch.lastName;
  if (patch.email !== undefined) set.email = patch.email;
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.isActive !== undefined) set.isActive = patch.isActive;

  const rows = await db.update(staff).set(set).where(eq(staff.id, id)).returning(staffView);
  return rows[0];
};

export const getCustomerById = async (db: AnyPgDatabase, id: string) => {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return rows[0];
};

export interface CustomerProfilePatch {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  preferredChannel?: 'sms' | 'whatsapp' | 'email';
  children?: ChildRecord[];
}

/**
 * Update editable customer fields. Phone is intentionally not editable here: it
 * is the login identity and may only be changed by staff.
 */
export const updateCustomerProfile = async (
  db: AnyPgDatabase,
  id: string,
  patch: CustomerProfilePatch,
  now: Date = new Date(),
) => {
  const set: Partial<typeof customers.$inferInsert> = { updatedAt: now };
  if (patch.firstName !== undefined) set.firstName = patch.firstName;
  if (patch.lastName !== undefined) set.lastName = patch.lastName;
  if (patch.email !== undefined) set.email = patch.email;
  if (patch.preferredChannel !== undefined) set.preferredChannel = patch.preferredChannel;
  if (patch.children !== undefined) set.children = patch.children;

  const rows = await db.update(customers).set(set).where(eq(customers.id, id)).returning();
  return rows[0];
};

/** Link a customer to their WordPress user id (set once by the WP sync job). */
export const setCustomerWpUserId = async (
  db: AnyPgDatabase,
  id: string,
  wpUserId: number,
  now: Date = new Date(),
) => {
  const rows = await db
    .update(customers)
    .set({ wpUserId, updatedAt: now })
    .where(eq(customers.id, id))
    .returning({ id: customers.id, wpUserId: customers.wpUserId });
  return rows[0];
};
