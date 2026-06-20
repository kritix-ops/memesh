import { randomBytes } from 'node:crypto';
import { type Customer, setCustomerWpUserId } from '@memesh/db';
import type { WpClient } from './wp-client.js';

type SyncableCustomer = Pick<
  Customer,
  'id' | 'firstName' | 'lastName' | 'phone' | 'email' | 'wpUserId'
>;

const syntheticEmail = (phone: string): string => `${phone.replace(/\D/g, '')}@memesh.local`;

/**
 * Create a matching WordPress user for a customer and store the wp_user_id.
 * Idempotent (skips if already linked). Intended to be called fire-and-forget
 * from the customer-create path: it must never block or fail that request, so
 * the caller swallows errors.
 */
export const syncCustomerToWp = async (
  client: WpClient,
  db: Parameters<typeof setCustomerWpUserId>[0],
  customer: SyncableCustomer,
): Promise<void> => {
  if (customer.wpUserId) return;
  const created = await client.createUser({
    username: customer.phone,
    email: customer.email ?? syntheticEmail(customer.phone),
    firstName: customer.firstName,
    lastName: customer.lastName,
    password: randomBytes(24).toString('base64url'),
    roles: ['subscriber'],
  });
  await setCustomerWpUserId(db, customer.id, created.id);
};
