import { hashPassword, verifyPassword } from '@memesh/auth';
import {
  db,
  getCardSettings,
  getStaffPin,
  isStaffPinLocked,
  recordStaffPinFailure,
  recordStaffPinSuccess,
  setStaffPin as setStaffPinRow,
} from '@memesh/db';

/**
 * High-level PIN operations for the cashier attribution flow. The db package
 * deals only in already-hashed values + state primitives; this wrapper composes
 * them with @memesh/auth's scrypt for the raw-PIN entry points — same split as
 * accounts.ts ↔ apps/api/src/lib/staff-repo.ts.
 *
 * Verification ordering (read once, then update inside the same transaction
 * inside the db primitive) ensures lockout + failure counts can't drift if
 * two PIN attempts arrive concurrently for the same cashier.
 */

export type VerifyPinResult =
  | { ok: true }
  | { ok: false; reason: 'no_pin' }
  | { ok: false; reason: 'locked'; lockedUntil: Date }
  | { ok: false; reason: 'invalid_pin'; failedCount: number; locked: boolean };

export async function setStaffPinFromRaw(staffId: string, rawPin: string): Promise<void> {
  const pinHash = await hashPassword(rawPin);
  await setStaffPinRow(db, { staffId, pinHash });
}

export async function verifyStaffPin(staffId: string, rawPin: string): Promise<VerifyPinResult> {
  const row = await getStaffPin(db, staffId);
  if (!row) return { ok: false, reason: 'no_pin' };
  const now = new Date();
  if (isStaffPinLocked(row, now)) {
    return { ok: false, reason: 'locked', lockedUntil: row.lockedUntil! };
  }
  const match = await verifyPassword(rawPin, row.pinHash);
  if (match) {
    await recordStaffPinSuccess(db, staffId, now);
    return { ok: true };
  }
  const settings = await getCardSettings(db);
  const result = await recordStaffPinFailure(db, {
    staffId,
    maxFailures: settings.pinMaxFailures,
    lockoutMinutes: settings.pinLockoutMinutes,
    now,
  });
  return {
    ok: false,
    reason: 'invalid_pin',
    failedCount: result.failedCount,
    locked: result.lockedUntil !== null,
  };
}
