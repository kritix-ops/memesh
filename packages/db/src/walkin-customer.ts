// Anonymous cash walk-in (Yanay 2026-07-13): the floor needs to drop a head onto
// a round without collecting a name or phone. But bookings.customer_id is NOT
// NULL, so an "anonymous" booking still needs a customer to point at. That's
// this: one reserved system customer that every anonymous walk-in books under,
// distinguished from each other by their booking number. It is deliberately
// hidden from the customer directory, the customers report, and the reminder
// recipients (see the WALKIN_SENTINEL_PHONE exclusions in those modules) so it
// never surfaces as a real person or gets an SMS to its placeholder phone.

import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customers } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

/** Placeholder phone on the sentinel row. Not a real number — it is the marker
 *  every "hide the walk-in customer" filter keys off, and it can never collide
 *  with a real phone. */
export const WALKIN_SENTINEL_PHONE = '__walkin__';

/** Reserved customer number for the sentinel. The L-NNNN sequence starts at 1,
 *  so L-0000 is guaranteed never to be allocated to a real customer. */
export const WALKIN_SENTINEL_CUSTOMER_NUMBER = 'L-0000';

/** Display name on the sentinel — what the attendee list and the door show for
 *  an anonymous entry ("כניסה במקום"). */
const WALKIN_SENTINEL_FIRST_NAME = 'כניסה';
const WALKIN_SENTINEL_LAST_NAME = 'במקום';

/**
 * Resolve the single reserved walk-in customer, creating it on first use.
 * Race-safe: a concurrent first-add can't create a duplicate because both the
 * phone and the customer number are UNIQUE and the insert is ON CONFLICT DO
 * NOTHING, after which the row is guaranteed to exist and is re-selected.
 */
export const getOrCreateWalkInCustomerId = async (db: AnyPgDatabase): Promise<string> => {
  const existing = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.phone, WALKIN_SENTINEL_PHONE))
    .limit(1);
  if (existing[0]) return existing[0].id;

  await db
    .insert(customers)
    .values({
      customerNumber: WALKIN_SENTINEL_CUSTOMER_NUMBER,
      firstName: WALKIN_SENTINEL_FIRST_NAME,
      lastName: WALKIN_SENTINEL_LAST_NAME,
      phone: WALKIN_SENTINEL_PHONE,
    })
    .onConflictDoNothing();

  const created = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.phone, WALKIN_SENTINEL_PHONE))
    .limit(1);
  if (!created[0]) throw new Error('[walkin-customer] sentinel missing after upsert');
  return created[0].id;
};
