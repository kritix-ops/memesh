import { db, users } from '@memesh/db';
import type { WcOrderBilling } from './wc-webhook.js';
import { eq, sql } from 'drizzle-orm';

const fallback = (value: string | undefined, fallbackValue: string): string =>
  value && value.trim().length > 0 ? value.trim() : fallbackValue;

const syntheticEmail = (wpUserId: number): string => `wp-${wpUserId}@no-email.memesh.local`;

export const findOrCreateUserByWp = async (
  wpUserId: number,
  billing: WcOrderBilling,
): Promise<{ id: string; createdNew: boolean }> => {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.wpUserId, wpUserId))
    .limit(1);

  if (existing[0]) {
    return { id: existing[0].id, createdNew: false };
  }

  const email = fallback(billing.email, syntheticEmail(wpUserId));

  // Re-check by email (a customer might exist under email without wp_user_id yet,
  // e.g. created from a POS sale, then later registered on WP).
  const byEmail = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (byEmail[0]) {
    await db
      .update(users)
      .set({ wpUserId, updatedAt: sql`now()` })
      .where(eq(users.id, byEmail[0].id));
    return { id: byEmail[0].id, createdNew: false };
  }

  const inserted = await db
    .insert(users)
    .values({
      wpUserId,
      firstName: fallback(billing.first_name, 'Customer'),
      lastName: fallback(billing.last_name, String(wpUserId)),
      email,
      phone: billing.phone ?? null,
      role: 'customer',
    })
    .returning({ id: users.id });

  const row = inserted[0];
  if (!row) throw new Error('[users-repo] insert returned no row');
  return { id: row.id, createdNew: true };
};
