import { randomUUID } from 'node:crypto';
import { generateSerial, signToken, type KeyResolver } from '@memesh/qr-engine';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { logStaffAction } from './actions';
import { customers, punchCardEntries, punchCards, staff } from './schema/index';

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

export interface CancelCardInput {
  cardId: string;
  staffId?: string;
  reason: string;
  now?: Date;
}

/**
 * Detail for a single card: card row + owning customer (public fields) + the
 * full entry history with the punching staff's name joined in. Used by the
 * admin "drill into a card" view.
 */
export const cardDetail = async (db: AnyPgDatabase, cardId: string) => {
  const cardRows = await db
    .select({
      id: punchCards.id,
      customerId: punchCards.customerId,
      serialNumber: punchCards.serialNumber,
      keyId: punchCards.keyId,
      totalEntries: punchCards.totalEntries,
      usedEntries: punchCards.usedEntries,
      isActive: punchCards.isActive,
      expiresAt: punchCards.expiresAt,
      source: punchCards.source,
      wcOrderId: punchCards.wcOrderId,
      cancelledAt: punchCards.cancelledAt,
      cancelledBy: punchCards.cancelledBy,
      cancelReason: punchCards.cancelReason,
      createdAt: punchCards.createdAt,
      updatedAt: punchCards.updatedAt,
      customerNumber: customers.customerNumber,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      customerPhone: customers.phone,
      customerEmail: customers.email,
    })
    .from(punchCards)
    .leftJoin(customers, eq(customers.id, punchCards.customerId))
    .where(eq(punchCards.id, cardId))
    .limit(1);

  const card = cardRows[0];
  if (!card) return undefined;

  const entries = await db
    .select({
      id: punchCardEntries.id,
      punchedAt: punchCardEntries.punchedAt,
      method: punchCardEntries.method,
      companionCount: punchCardEntries.companionCount,
      notes: punchCardEntries.notes,
      punchedBy: punchCardEntries.punchedBy,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
    })
    .from(punchCardEntries)
    .leftJoin(staff, eq(staff.id, punchCardEntries.punchedBy))
    .where(eq(punchCardEntries.punchCardId, cardId))
    .orderBy(desc(punchCardEntries.punchedAt));

  return { card, entries };
};

export type CardListStatus = 'active' | 'expired' | 'cancelled';

export interface ListCardsInput {
  status?: CardListStatus | undefined;
  /** Server-side cap. Caller is expected to clamp; default 100, max 200 typical. */
  limit?: number | undefined;
}

/**
 * List cards joined with customer info, filtered by status, for the admin
 * "ניהול כרטיסיות" view. Buckets are mutually exclusive:
 *   - active:    is_active = true
 *   - cancelled: cancelled_at IS NOT NULL  (also is_active = false)
 *   - expired:   is_active = false AND cancelled_at IS NULL
 *     (covers expiry-by-time AND exhausted 12/12 — operationally one bucket)
 */
export const listCards = async (db: AnyPgDatabase, input: ListCardsInput = {}) => {
  const limit = input.limit ?? 100;
  const conds = [];
  if (input.status === 'active') {
    conds.push(eq(punchCards.isActive, true));
  } else if (input.status === 'cancelled') {
    conds.push(isNotNull(punchCards.cancelledAt));
  } else if (input.status === 'expired') {
    conds.push(eq(punchCards.isActive, false));
    conds.push(isNull(punchCards.cancelledAt));
  }
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  let query = db
    .select({
      id: punchCards.id,
      customerId: punchCards.customerId,
      serialNumber: punchCards.serialNumber,
      totalEntries: punchCards.totalEntries,
      usedEntries: punchCards.usedEntries,
      isActive: punchCards.isActive,
      expiresAt: punchCards.expiresAt,
      cancelledAt: punchCards.cancelledAt,
      cancelReason: punchCards.cancelReason,
      source: punchCards.source,
      createdAt: punchCards.createdAt,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      customerNumber: customers.customerNumber,
      customerPhone: customers.phone,
    })
    .from(punchCards)
    .leftJoin(customers, eq(customers.id, punchCards.customerId))
    .$dynamic();
  if (where) query = query.where(where);
  return query.orderBy(desc(punchCards.createdAt)).limit(limit);
};

/**
 * Cancel a card: deactivate it, record who/why, and log a staff action.
 * Returns undefined if the card does not exist OR if it is already cancelled
 * (we never overwrite an existing cancel audit row — the API surfaces this as
 * a clean 404 on a second cancel attempt).
 */
export const cancelCard = async (db: AnyPgDatabase, input: CancelCardInput) => {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // Guard: refuse to re-cancel an already-cancelled card.
    const existing = await tx
      .select({ id: punchCards.id, cancelledAt: punchCards.cancelledAt })
      .from(punchCards)
      .where(eq(punchCards.id, input.cardId))
      .limit(1);
    const found = existing[0];
    if (!found || found.cancelledAt) return undefined;

    const rows = await tx
      .update(punchCards)
      .set({
        isActive: false,
        cancelledAt: now,
        cancelledBy: input.staffId ?? null,
        cancelReason: input.reason,
        updatedAt: now,
      })
      .where(eq(punchCards.id, input.cardId))
      .returning();
    const card = rows[0];
    if (!card) return undefined;
    await logStaffAction(tx, {
      action: 'cancel_card',
      summary: `ביטול כרטיסייה · ${card.serialNumber}`,
      now,
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
    });
    return card;
  });
};
