import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { staffPins, type StaffPin } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

// Repository primitives for the cashier attribution PIN. The full
// verify-with-lockout flow is composed in apps/api/src/lib/staff-pin-repo.ts
// where the scrypt hashing utilities from @memesh/auth live — keeping the db
// package free of an auth dependency, matching the existing staff/password
// split in accounts.ts ↔ staff-repo.ts.

/**
 * Generate a random numeric PIN of the requested length. Uses crypto.randomInt
 * (uniform integer in a half-open range) so the output is unbiased — Math.random
 * skews on edge buckets. Allows leading zeros so the full key-space is covered.
 */
export const generateRandomPin = (length: number): string => {
  if (!Number.isInteger(length) || length < 3 || length > 12) {
    throw new Error(`[generateRandomPin] length out of range: ${length}`);
  }
  const upper = 10 ** length;
  const value = randomInt(0, upper);
  return String(value).padStart(length, '0');
};

/** Read the PIN row for a cashier. Returns undefined when no PIN is set. */
export const getStaffPin = async (
  db: AnyPgDatabase,
  staffId: string,
): Promise<StaffPin | undefined> => {
  const rows = await db.select().from(staffPins).where(eq(staffPins.staffId, staffId)).limit(1);
  return rows[0];
};

export interface SetStaffPinInput {
  staffId: string;
  /** Already hashed by the caller (scrypt via @memesh/auth). */
  pinHash: string;
  now?: Date;
}

/**
 * Upsert the PIN row for a staff member. Resets `failed_count` and clears any
 * `locked_until` — setting a new PIN is an explicit "this cashier is back in
 * business" signal whether the action came from admin or self-service.
 */
export const setStaffPin = async (db: AnyPgDatabase, input: SetStaffPinInput): Promise<StaffPin> => {
  const now = input.now ?? new Date();
  const rows = await db
    .insert(staffPins)
    .values({
      staffId: input.staffId,
      pinHash: input.pinHash,
      failedCount: 0,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: staffPins.staffId,
      set: {
        pinHash: input.pinHash,
        failedCount: 0,
        lockedUntil: null,
        updatedAt: now,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('[setStaffPin] upsert returned no row');
  return row;
};

/** Remove the PIN row entirely. After this the cashier cannot sell until a new PIN is set. */
export const deleteStaffPin = async (db: AnyPgDatabase, staffId: string): Promise<boolean> => {
  const rows = await db
    .delete(staffPins)
    .where(eq(staffPins.staffId, staffId))
    .returning({ id: staffPins.id });
  return rows.length > 0;
};

/** Reset failure counter + lockout. Called when a manager unlocks a cashier. */
export const unlockStaffPin = async (
  db: AnyPgDatabase,
  staffId: string,
  now: Date = new Date(),
): Promise<boolean> => {
  const rows = await db
    .update(staffPins)
    .set({ failedCount: 0, lockedUntil: null, updatedAt: now })
    .where(eq(staffPins.staffId, staffId))
    .returning({ id: staffPins.id });
  return rows.length > 0;
};

/** Reset failure counter on a successful PIN entry. Lockout is already known-null. */
export const recordStaffPinSuccess = async (
  db: AnyPgDatabase,
  staffId: string,
  now: Date = new Date(),
): Promise<void> => {
  await db
    .update(staffPins)
    .set({ failedCount: 0, updatedAt: now })
    .where(eq(staffPins.staffId, staffId));
};

export interface RecordStaffPinFailureInput {
  staffId: string;
  /** From settings.pinMaxFailures — when failedCount reaches this, we lock. */
  maxFailures: number;
  /** From settings.pinLockoutMinutes — lockout window when triggered. */
  lockoutMinutes: number;
  now?: Date;
}

export interface RecordStaffPinFailureResult {
  /** failed_count value after the increment. */
  failedCount: number;
  /** Non-null when this failure crossed the threshold and locked the PIN. */
  lockedUntil: Date | null;
}

/**
 * Increment the failure counter and, if it crosses the configured threshold,
 * stamp `locked_until = now + lockoutMinutes`. Returns the post-update state
 * so the caller can render the right error to the cashier.
 */
export const recordStaffPinFailure = async (
  db: AnyPgDatabase,
  input: RecordStaffPinFailureInput,
): Promise<RecordStaffPinFailureResult> => {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(staffPins)
      .where(eq(staffPins.staffId, input.staffId))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) {
      // Caller checked existence before calling us; surface as a clean error.
      throw new Error(`[recordStaffPinFailure] no PIN row for staff ${input.staffId}`);
    }
    const nextCount = row.failedCount + 1;
    const lockedUntil =
      nextCount >= input.maxFailures
        ? new Date(now.getTime() + input.lockoutMinutes * 60 * 1000)
        : null;
    await tx
      .update(staffPins)
      .set({ failedCount: nextCount, lockedUntil, updatedAt: now })
      .where(eq(staffPins.id, row.id));
    return { failedCount: nextCount, lockedUntil };
  });
};

/**
 * Convenience read-only check: returns true when a current lockout is active.
 * The verify flow re-reads the row inside its own transaction; this exists so
 * the API can short-circuit a sale before prompting for the PIN at all.
 */
export const isStaffPinLocked = (row: StaffPin, now: Date = new Date()): boolean =>
  row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();
