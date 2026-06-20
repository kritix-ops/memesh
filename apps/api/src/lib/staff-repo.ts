import { verifyPassword, type StaffRole } from '@memesh/auth';
import { db, staff } from '@memesh/db';
import { normalizeIsraeliPhone } from '@memesh/sms';
import { eq } from 'drizzle-orm';

export interface StaffLogin {
  id: string;
  role: StaffRole;
}

/**
 * Verify a staff phone + password/PIN. Returns the staff identity on success,
 * or undefined on any failure. Never distinguishes "no such phone" from "wrong
 * password" so the caller cannot probe which phones exist.
 *
 * Phone is normalized to the canonical 05XXXXXXXX form before lookup so the
 * login works regardless of whether the caller typed dashes, spaces, +972,
 * etc. Defense-in-depth: the route layer also normalizes via phoneSchema, so
 * this is a guard against a future caller that bypasses the schema.
 */
export const verifyStaffLogin = async (
  phone: string,
  password: string,
): Promise<StaffLogin | undefined> => {
  let normalized: string;
  try {
    normalized = normalizeIsraeliPhone(phone);
  } catch {
    return undefined;
  }
  const rows = await db.select().from(staff).where(eq(staff.phone, normalized)).limit(1);
  const row = rows[0];
  if (!row || !row.isActive || !row.passwordHash) return undefined;
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) return undefined;
  return { id: row.id, role: row.role };
};
