import { and, eq, sql } from 'drizzle-orm';
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

/**
 * Fetch a staff row by email (case-insensitive). Includes the password hash
 * because the only caller is the login + password-reset path (verifyStaffLogin,
 * forgot-password) — the public view never crosses the API boundary from here.
 *
 * Matches the partial unique index `staff_email_lower_unique` on
 * `lower(email) WHERE email IS NOT NULL`, so this lookup hits the index.
 */
export const getStaffByEmailWithSecret = async (db: AnyPgDatabase, email: string) => {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  const rows = await db
    .select()
    .from(staff)
    .where(sql`lower(${staff.email}) = ${normalized}`)
    .limit(1);
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

/**
 * Replace a staff member's password hash. Single-purpose helper used by the
 * password-reset flow; not exposed through the generic update primitive on
 * purpose, so a buggy patch caller can never silently rotate a credential.
 */
export const setStaffPasswordHash = async (
  db: AnyPgDatabase,
  id: string,
  passwordHash: string,
  now: Date = new Date(),
) => {
  const rows = await db
    .update(staff)
    .set({ passwordHash, updatedAt: now })
    .where(eq(staff.id, id))
    .returning({ id: staff.id });
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

/**
 * Hard-delete a staff row. Returns the deleted row's id (or undefined if no
 * row matched). Will throw the underlying Postgres error if the row is still
 * referenced by another table (customers.registeredBy, punch_card_entries.
 * punchedBy, punch_cards.cancelledBy, staff_actions.staffId); the route layer
 * surfaces that as a 409 with a clear message and tells the operator to
 * deactivate instead.
 */
export const deleteStaff = async (db: AnyPgDatabase, id: string) => {
  const rows = await db.delete(staff).where(eq(staff.id, id)).returning({ id: staff.id });
  return rows[0];
};

/** Count active admins, used by the route layer to refuse the last-admin delete. */
export const countActiveAdmins = async (db: AnyPgDatabase): Promise<number> => {
  const rows = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.role, 'admin'), eq(staff.isActive, true)));
  return rows.length;
};

/**
 * Hard-delete a customer row. Returns the deleted row's id (or undefined if
 * no row matched). Will throw on FK violations from punch_cards.customerId —
 * the route layer surfaces that as a 409.
 */
export const deleteCustomer = async (db: AnyPgDatabase, id: string) => {
  const rows = await db
    .delete(customers)
    .where(eq(customers.id, id))
    .returning({ id: customers.id });
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
