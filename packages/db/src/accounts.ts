import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  type ChildRecord,
  customers,
  punchCardEntries,
  punchCards,
  staff,
} from './schema/index';

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
 * Hard-delete a customer, cascading through their cancelled punch cards.
 *
 * Discriminated result:
 *   - { ok: false, reason: 'not_found' } — no customer with that id.
 *   - { ok: false, reason: 'has_active_cards', activeCount } — at least one
 *     card with `cancelled_at IS NULL`. The customer is preserved; the
 *     operator must cancel those cards first (matches the UI error message
 *     "בטלו את כל הכרטיסיות לפני המחיקה").
 *   - { ok: true, id } — customer deleted along with all their cancelled
 *     cards and the entries on those cards.
 *
 * The cancelled-cards-cascade is what Yanay's bug report on 2026-06-22
 * surfaced: cancelling a card makes the customer expect to be able to
 * delete the customer immediately, but `punch_cards.customer_id` is a
 * NO ACTION FK so the raw DELETE was blocked. We now cascade the cleanup
 * inside a single transaction so partial failure can't leave dangling
 * cards. `customer_login_tokens` is already ON DELETE CASCADE; staff_actions
 * doesn't reference customers/cards, so the audit log survives intact.
 */
export type DeleteCustomerResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'has_active_cards'; activeCount: number };

export const deleteCustomer = async (
  db: AnyPgDatabase,
  id: string,
): Promise<DeleteCustomerResult> => {
  return db.transaction(async (tx) => {
    // Load every card belonging to this customer in one round-trip. The set
    // is bounded (a customer has at most a handful of cards in their life),
    // so fetching all of them is cheaper than a separate COUNT(*) followed
    // by a SELECT for the cascade.
    const cards = await tx
      .select({ id: punchCards.id, cancelledAt: punchCards.cancelledAt })
      .from(punchCards)
      .where(eq(punchCards.customerId, id));

    const activeCount = cards.filter((c) => c.cancelledAt === null).length;
    if (activeCount > 0) {
      // Don't touch the customer; surface the count so the UI can show a
      // precise "you still have N active cards" message later if we want.
      return { ok: false, reason: 'has_active_cards', activeCount };
    }

    // All cards (if any) are cancelled. Wipe entries → cards → customer.
    if (cards.length > 0) {
      const cardIds = cards.map((c) => c.id);
      await tx.delete(punchCardEntries).where(inArray(punchCardEntries.punchCardId, cardIds));
      await tx.delete(punchCards).where(inArray(punchCards.id, cardIds));
    }

    const deleted = await tx
      .delete(customers)
      .where(eq(customers.id, id))
      .returning({ id: customers.id });
    const row = deleted[0];
    if (!row) return { ok: false, reason: 'not_found' };
    return { ok: true, id: row.id };
  });
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
