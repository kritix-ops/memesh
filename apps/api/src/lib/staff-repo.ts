import { verifyPassword, type StaffRole } from '@memesh/auth';
import { getStaffByEmailWithSecret } from '@memesh/db';
import { db } from '@memesh/db';

export interface StaffLogin {
  id: string;
  role: StaffRole;
}

/**
 * Verify a staff email + password. Returns the staff identity on success, or
 * undefined on any failure. Never distinguishes "no such email" from "wrong
 * password" so the caller cannot probe which emails exist.
 *
 * Email is looked up case-insensitively (the DB has a partial unique index on
 * lower(email)) so the login works regardless of how the user typed it.
 *
 * Username moved from phone to email on 2026-06-21. Phone is still a unique
 * contact id in the schema but is no longer a credential — a phone change no
 * longer invalidates the login.
 */
export const verifyStaffLogin = async (
  email: string,
  password: string,
): Promise<StaffLogin | undefined> => {
  const row = await getStaffByEmailWithSecret(db, email);
  if (!row || !row.isActive || !row.passwordHash) return undefined;
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) return undefined;
  return { id: row.id, role: row.role };
};
