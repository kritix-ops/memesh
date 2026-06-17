import { randomUUID } from 'node:crypto';
import { generateSerial, signToken, type KeyResolver } from '@memesh/qr-engine';
import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customers, punchCards } from './schema/index';

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
type AnyPgDatabase = PgDatabase<any, any, any>;

const CARD_VALIDITY_DAYS = 365;
const DEFAULT_TOTAL_ENTRIES = 12;

const extractRows = (result: unknown): Array<Record<string, unknown>> => {
  if (
    result &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return [];
};

const nextSequenceValue = async (db: AnyPgDatabase, sequence: string): Promise<number> => {
  // The sequence name is a fixed internal literal, not user input.
  const result = await db.execute(sql.raw(`SELECT nextval('${sequence}') AS nextval`));
  const row = extractRows(result)[0];
  if (!row) throw new Error(`[sequence] ${sequence} returned no row`);
  const value = Number(row.nextval);
  if (!Number.isFinite(value)) {
    throw new Error(`[sequence] ${sequence} returned a non-numeric value: ${String(row.nextval)}`);
  }
  return value;
};

/** Allocate the next human-friendly punch-card serial: M-YYYYMMDD-NNNN. */
export const allocateSerial = async (
  db: AnyPgDatabase,
  date: Date = new Date(),
): Promise<string> => {
  const sequence = await nextSequenceValue(db, 'punch_card_serial_seq');
  return generateSerial({ date, sequence });
};

/** Allocate the next customer number: L-NNNN. */
export const allocateCustomerNumber = async (db: AnyPgDatabase): Promise<string> => {
  const value = await nextSequenceValue(db, 'customer_number_seq');
  return `L-${String(value).padStart(4, '0')}`;
};

export interface CreateCustomerInput {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  preferredChannel?: 'sms' | 'whatsapp' | 'email';
  registeredBy?: string; // staff id
}

/** Create a customer with an allocated L-NNNN customer number. */
export const createCustomer = async (db: AnyPgDatabase, input: CreateCustomerInput) => {
  const customerNumber = await allocateCustomerNumber(db);
  const rows = await db
    .insert(customers)
    .values({
      customerNumber,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email ?? null,
      preferredChannel: input.preferredChannel ?? 'sms',
      registeredBy: input.registeredBy ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('[createCustomer] insert returned no row');
  return row;
};

export interface CreatePunchCardInput {
  customerId: string;
  source?: 'pos' | 'online' | 'manual';
  totalEntries?: number;
  wcOrderId?: string;
  now?: Date;
}

/**
 * Create a punch card: allocate a serial, mint a server-signed QR token bound to
 * the card id, and store it with a one-year expiry. The QR carries no authority
 * of its own; verification always goes back to this row.
 */
export const createPunchCard = async (
  db: AnyPgDatabase,
  resolver: KeyResolver,
  input: CreatePunchCardInput,
) => {
  const now = input.now ?? new Date();
  const id = randomUUID();
  const serialNumber = await allocateSerial(db, now);
  const { keyId } = resolver.resolveSigningKey();
  const qrToken = signToken(
    {
      punchCardId: id,
      customerId: input.customerId,
      createdTs: Math.floor(now.getTime() / 1000),
      serial: serialNumber,
    },
    resolver,
  );
  const expiresAt = new Date(now.getTime() + CARD_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .insert(punchCards)
    .values({
      id,
      customerId: input.customerId,
      serialNumber,
      qrToken,
      keyId,
      totalEntries: input.totalEntries ?? DEFAULT_TOTAL_ENTRIES,
      expiresAt,
      source: input.source ?? 'pos',
      wcOrderId: input.wcOrderId ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('[createPunchCard] insert returned no row');
  return row;
};
