import { randomUUID } from 'node:crypto';
import { generateSerial, signToken, type KeyResolver } from '@memesh/qr-engine';
import { and, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias, type PgDatabase } from 'drizzle-orm/pg-core';
import { logStaffAction } from './actions';
import { getCardSettings } from './card-settings';
import {
  customers,
  punchCardEntries,
  punchCards,
  staff,
  type ChildRecord,
} from './schema/index';

// Aliased view of `staff` for joining the "selling cashier" on punch_cards.
// Using an alias keeps the join unambiguous in queries that also reference
// staff for other reasons (e.g. cancelledBy in the future) and reads cleanly
// in the select shape (sellerFirstName vs. staffFirstName).
const seller = alias(staff, 'seller');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
type AnyPgDatabase = PgDatabase<any, any, any>;

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
  /** How the customer found us. Matches the customer_source enum. */
  source?: 'referral' | 'social' | 'walk_by' | 'website' | 'other';
  /** Children (jsonb) — name + dob + optional notes. Marketing-valuable for a gymboree. */
  children?: ChildRecord[];
  /**
   * If true, marketing_consent_at is set to `now`. If false or omitted, left
   * null. This is the legal hook for any future marketing dispatch.
   */
  marketingConsent?: boolean;
  /** Override `now` for tests. */
  now?: Date;
}

/** Create a customer with an allocated L-NNNN customer number. */
export const createCustomer = async (db: AnyPgDatabase, input: CreateCustomerInput) => {
  const customerNumber = await allocateCustomerNumber(db);
  const now = input.now ?? new Date();
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
      source: input.source ?? null,
      children: input.children ?? [],
      marketingConsentAt: input.marketingConsent ? now : null,
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
  /**
   * Override the card's lifetime explicitly.
   * - `undefined` → use settings.validityDays
   * - `null` → forever (expiresAt: null)
   * - `0` → forever (matches settings sentinel)
   * - `1..3650` → set expiresAt = now + N days
   * Admin-only at the route layer; the db function does not enforce role.
   */
  validityDays?: number | null;
  wcOrderId?: string;
  /**
   * AccuPOS receipt number recorded at the till. Required by the API for
   * `source='pos'` (settings-driven). The DB enforces uniqueness — passing a
   * duplicate raises a Postgres unique-violation that the route layer maps
   * to a 409 receipt_number_duplicate.
   */
  receiptNumber?: string;
  /** Cashier who issued the card (attribution PIN at the till). */
  soldBy?: string;
  now?: Date;
}

/**
 * Create a punch card: allocate a serial, mint a server-signed QR token bound
 * to the card id, and store it with the configured expiry. The QR carries no
 * authority of its own; verification always goes back to this row.
 *
 * Validity days and default total entries come from `card_settings`. An
 * explicit `input.totalEntries` still wins (POS may override per sale).
 */
export const createPunchCard = async (
  db: AnyPgDatabase,
  resolver: KeyResolver,
  input: CreatePunchCardInput,
) => {
  const now = input.now ?? new Date();
  const settings = await getCardSettings(db);
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
  // Resolve effective validity. Admin can override settings via input.
  // `null` or `0` both mean forever.
  const effectiveValidity =
    input.validityDays === undefined ? settings.validityDays : input.validityDays;
  const expiresAt =
    effectiveValidity === null || effectiveValidity === 0
      ? null
      : new Date(now.getTime() + effectiveValidity * 24 * 60 * 60 * 1000);
  const rows = await db
    .insert(punchCards)
    .values({
      id,
      customerId: input.customerId,
      serialNumber,
      qrToken,
      keyId,
      totalEntries: input.totalEntries ?? settings.totalEntries,
      expiresAt,
      source: input.source ?? 'pos',
      wcOrderId: input.wcOrderId ?? null,
      ...(input.receiptNumber !== undefined && { receiptNumber: input.receiptNumber }),
      ...(input.soldBy !== undefined && { soldBy: input.soldBy }),
      // When the caller injects `now` (tests, backfill), honor it for
      // createdAt too — otherwise the row default Now() would diverge
      // from expiresAt arithmetic.
      ...(input.now !== undefined && { createdAt: input.now, updatedAt: input.now }),
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
      receiptNumber: punchCards.receiptNumber,
      soldBy: punchCards.soldBy,
      soldByFirstName: seller.firstName,
      soldByLastName: seller.lastName,
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
    .leftJoin(seller, eq(seller.id, punchCards.soldBy))
    .where(eq(punchCards.id, cardId))
    .limit(1);

  const card = cardRows[0];
  if (!card) return undefined;

  const entries = await db
    .select({
      id: punchCardEntries.id,
      punchedAt: punchCardEntries.punchedAt,
      method: punchCardEntries.method,
      entriesConsumed: punchCardEntries.entriesConsumed,
      notes: punchCardEntries.notes,
      punchedBy: punchCardEntries.punchedBy,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
      refundedAt: punchCardEntries.refundedAt,
      refundReason: punchCardEntries.refundReason,
    })
    .from(punchCardEntries)
    .leftJoin(staff, eq(staff.id, punchCardEntries.punchedBy))
    .where(eq(punchCardEntries.punchCardId, cardId))
    .orderBy(desc(punchCardEntries.punchedAt));

  return { card, entries };
};

/**
 * Same card row used by the POS scan-preview screen. Returns the customer's
 * marketing children alongside the card + entry history, and derives a single
 * `status` flag the cashier sees as a coloured banner.
 *
 * Status precedence: cancellation > exhaustion > expiry > grace > ok.
 * - `cancelled` wins over `exhausted`/`expired` because the cancel reason is
 *   the most actionable thing to tell the customer at the counter.
 * - `grace` lights up when the card is past its hard expiry but within the
 *   configured `gracePeriodDays` window — punch is still allowed with a
 *   warning banner.
 * - `expiresInDays` is included so the POS can render an "expiring soon"
 *   badge when within `expiryBadgeThresholdDays` (frontend renders that).
 */
export const scanCardLookup = async (
  db: AnyPgDatabase,
  cardId: string,
  now: Date = new Date(),
) => {
  const settings = await getCardSettings(db);

  const cardRows = await db
    .select({
      id: punchCards.id,
      serialNumber: punchCards.serialNumber,
      totalEntries: punchCards.totalEntries,
      usedEntries: punchCards.usedEntries,
      isActive: punchCards.isActive,
      expiresAt: punchCards.expiresAt,
      cancelledAt: punchCards.cancelledAt,
      cancelReason: punchCards.cancelReason,
      createdAt: punchCards.createdAt,
      customerId: customers.id,
      customerNumber: customers.customerNumber,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      customerPhone: customers.phone,
      customerChildren: customers.children,
    })
    .from(punchCards)
    .leftJoin(customers, eq(customers.id, punchCards.customerId))
    .where(eq(punchCards.id, cardId))
    .limit(1);

  const row = cardRows[0];
  if (!row) return undefined;

  const entries = await db
    .select({
      id: punchCardEntries.id,
      punchedAt: punchCardEntries.punchedAt,
      method: punchCardEntries.method,
      entriesConsumed: punchCardEntries.entriesConsumed,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
      refundedAt: punchCardEntries.refundedAt,
      refundReason: punchCardEntries.refundReason,
    })
    .from(punchCardEntries)
    .leftJoin(staff, eq(staff.id, punchCardEntries.punchedBy))
    .where(eq(punchCardEntries.punchCardId, cardId))
    .orderBy(desc(punchCardEntries.punchedAt));

  // `expiresAt: null` = "forever" card (validityDays=0). No expiry status
  // can apply, and expiresInDays is null so the frontend renders "ללא תפוגה".
  const isForever = row.expiresAt === null;
  const expiresMs = isForever ? null : row.expiresAt!.getTime();
  const graceCutoffMs =
    expiresMs === null ? null : expiresMs + settings.gracePeriodDays * MS_PER_DAY;
  const expiresInDays =
    expiresMs === null ? null : Math.ceil((expiresMs - now.getTime()) / MS_PER_DAY);

  let status: 'ok' | 'cancelled' | 'exhausted' | 'expired' | 'grace';
  if (row.cancelledAt) status = 'cancelled';
  else if (row.usedEntries >= row.totalEntries) status = 'exhausted';
  else if (
    expiresMs !== null &&
    graceCutoffMs !== null &&
    expiresMs <= now.getTime() &&
    now.getTime() <= graceCutoffMs &&
    settings.gracePeriodDays > 0
  ) {
    status = 'grace';
  } else if (expiresMs !== null && expiresMs <= now.getTime()) status = 'expired';
  else status = 'ok';

  return {
    status,
    expiresInDays,
    /** Echoed from settings so the frontend can render "expiring soon" without a second roundtrip. */
    expiryBadgeThresholdDays: settings.expiryBadgeThresholdDays,
    card: {
      id: row.id,
      serialNumber: row.serialNumber,
      totalEntries: row.totalEntries,
      usedEntries: row.usedEntries,
      isActive: row.isActive,
      expiresAt: row.expiresAt,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      createdAt: row.createdAt,
    },
    customer: {
      id: row.customerId,
      customerNumber: row.customerNumber,
      firstName: row.customerFirstName,
      lastName: row.customerLastName,
      phone: row.customerPhone,
      children: row.customerChildren ?? [],
    },
    entries,
  };
};

export type CardListStatus = 'active' | 'expired' | 'cancelled';

export interface ListCardsInput {
  status?: CardListStatus | undefined;
  /** Server-side cap. Caller is expected to clamp; default 100, max 200 typical. */
  limit?: number | undefined;
  /** Free-text search across serial + customer name / phone / number. */
  q?: string | undefined;
}

/**
 * List cards joined with customer info, filtered by status, for the admin
 * "ניהול כרטיסיות" view. Buckets are mutually exclusive:
 *   - active:    is_active = true
 *   - cancelled: cancelled_at IS NOT NULL  (also is_active = false)
 *   - expired:   is_active = false AND cancelled_at IS NULL
 *     (covers expiry-by-time AND exhausted 12/12 — operationally one bucket)
 *
 * Optional `q` runs an ILIKE across serial + customer name/phone/number.
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
  const q = input.q?.trim();
  if (q) {
    const pattern = `%${q}%`;
    const qCondition = or(
      ilike(punchCards.serialNumber, pattern),
      // Receipt number search lets Yanay drill into a suspect AccuPOS receipt
      // and find the matching punch card directly.
      ilike(punchCards.receiptNumber, pattern),
      ilike(customers.firstName, pattern),
      ilike(customers.lastName, pattern),
      ilike(customers.phone, pattern),
      ilike(customers.customerNumber, pattern),
    );
    if (qCondition) conds.push(qCondition);
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
      receiptNumber: punchCards.receiptNumber,
      soldBy: punchCards.soldBy,
      soldByFirstName: seller.firstName,
      soldByLastName: seller.lastName,
      createdAt: punchCards.createdAt,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      customerNumber: customers.customerNumber,
      customerPhone: customers.phone,
    })
    .from(punchCards)
    .leftJoin(customers, eq(customers.id, punchCards.customerId))
    .leftJoin(seller, eq(seller.id, punchCards.soldBy))
    .$dynamic();
  if (where) query = query.where(where);
  return query.orderBy(desc(punchCards.createdAt)).limit(limit);
};

export type CancelCardFailure =
  | 'not_found'
  | 'cancel_blocked_after_punch'
  | 'reason_too_short';

export type CancelCardResult =
  | { ok: true; card: typeof punchCards.$inferSelect }
  | { ok: false; reason: CancelCardFailure; minLength?: number; usedEntries?: number };

/**
 * Cancel a card: deactivate it, record who/why, and log a staff action.
 *
 * Returns `{ ok:false, reason:'not_found' }` if the card does not exist OR if
 * it is already cancelled (we never overwrite an existing cancel audit row —
 * the API surfaces this as a clean 404 on a second cancel attempt).
 *
 * Enforces settings-driven rules:
 * - `allowCancelAfterFirstPunch=false` → `cancel_blocked_after_punch` when
 *   the card has any usedEntries.
 * - `minCancelReasonLength` → `reason_too_short` when reason.trim() is
 *   shorter than the configured length.
 */
export const cancelCard = async (
  db: AnyPgDatabase,
  input: CancelCardInput,
): Promise<CancelCardResult> => {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const settings = await getCardSettings(tx);

    const trimmedReason = input.reason.trim();
    if (trimmedReason.length < settings.minCancelReasonLength) {
      return {
        ok: false,
        reason: 'reason_too_short',
        minLength: settings.minCancelReasonLength,
      };
    }

    const existing = await tx
      .select({
        id: punchCards.id,
        cancelledAt: punchCards.cancelledAt,
        usedEntries: punchCards.usedEntries,
      })
      .from(punchCards)
      .where(eq(punchCards.id, input.cardId))
      .limit(1);
    const found = existing[0];
    if (!found || found.cancelledAt) return { ok: false, reason: 'not_found' };

    if (!settings.allowCancelAfterFirstPunch && found.usedEntries > 0) {
      return {
        ok: false,
        reason: 'cancel_blocked_after_punch',
        usedEntries: found.usedEntries,
      };
    }

    const rows = await tx
      .update(punchCards)
      .set({
        isActive: false,
        cancelledAt: now,
        cancelledBy: input.staffId ?? null,
        cancelReason: trimmedReason,
        updatedAt: now,
      })
      .where(eq(punchCards.id, input.cardId))
      .returning();
    const card = rows[0];
    if (!card) return { ok: false, reason: 'not_found' };
    await logStaffAction(tx, {
      action: 'cancel_card',
      summary: `ביטול כרטיסייה · ${card.serialNumber}`,
      now,
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
    });
    return { ok: true, card };
  });
};

export type ReassignCardFailure =
  | 'card_not_found'
  | 'customer_not_found'
  | 'card_cancelled'
  | 'same_customer';

export interface ReassignCardInput {
  cardId: string;
  newCustomerId: string;
  staffId?: string;
  now?: Date;
}

export type ReassignCardResult =
  | { ok: true; card: typeof punchCards.$inferSelect; fromCustomerNumber: string | null }
  | { ok: false; reason: ReassignCardFailure };

/**
 * Move a card from its current owner to a different customer. Entries and
 * usedEntries stay attached to the card — the new owner inherits the card's
 * state, history and all. Audit row records both from/to customer numbers
 * so the trail is human-readable.
 *
 * Refuses cancelled cards (a cancelled card is dead — reassigning it has no
 * defensible business meaning) and no-op same-customer moves.
 */
export const reassignCard = async (
  db: AnyPgDatabase,
  input: ReassignCardInput,
): Promise<ReassignCardResult> => {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const cardRows = await tx
      .select()
      .from(punchCards)
      .where(eq(punchCards.id, input.cardId))
      .for('update')
      .limit(1);
    const card = cardRows[0];
    if (!card) return { ok: false, reason: 'card_not_found' };
    if (card.cancelledAt) return { ok: false, reason: 'card_cancelled' };
    if (card.customerId === input.newCustomerId) return { ok: false, reason: 'same_customer' };

    // Resolve the source + target customer numbers for the audit summary.
    const fromRows = await tx
      .select({ customerNumber: customers.customerNumber })
      .from(customers)
      .where(eq(customers.id, card.customerId))
      .limit(1);
    const toRows = await tx
      .select({ id: customers.id, customerNumber: customers.customerNumber })
      .from(customers)
      .where(eq(customers.id, input.newCustomerId))
      .limit(1);
    const toCustomer = toRows[0];
    if (!toCustomer) return { ok: false, reason: 'customer_not_found' };

    const updated = await tx
      .update(punchCards)
      .set({ customerId: input.newCustomerId, updatedAt: now })
      .where(eq(punchCards.id, card.id))
      .returning();
    const newCard = updated[0];
    if (!newCard) return { ok: false, reason: 'card_not_found' };

    const fromNumber = fromRows[0]?.customerNumber ?? null;
    await logStaffAction(tx, {
      action: 'reassign_card',
      summary: `העברת כרטיסייה ${card.serialNumber} · ${fromNumber ?? '?'} → ${toCustomer.customerNumber}`,
      now,
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
    });

    return { ok: true, card: newCard, fromCustomerNumber: fromNumber };
  });
};

// ---------------------------------------------------------------------------
// editCard — admin-only direct edit of an existing card. Currently editable:
// expiresAt (Date | null), totalEntries, source. Used + isActive are not
// directly editable here:
//   - reducing used is the refund flow (per-entry audit trail).
//   - increasing used = a missed punch; that's a manual-punch feature, not
//     part of the edit surface.
//   - isActive flips automatically when totalEntries changes such that the
//     card moves into/out of exhaustion.
// ---------------------------------------------------------------------------

export type EditCardFailure =
  | 'card_not_found'
  | 'card_cancelled'
  | 'total_below_used'
  | 'total_out_of_range'
  | 'no_changes';

export interface EditCardInput {
  cardId: string;
  /** undefined = keep, null = forever (no expiry), Date = new expiry. */
  expiresAt?: Date | null;
  totalEntries?: number;
  source?: 'pos' | 'online' | 'manual';
  staffId?: string;
  now?: Date;
}

export type EditCardResult =
  | {
      ok: true;
      card: typeof punchCards.$inferSelect;
      diff: Record<string, [unknown, unknown]>;
      reactivated: boolean;
    }
  | {
      ok: false;
      reason: EditCardFailure;
      usedEntries?: number;
    };

const editCardRange = { totalEntries: { min: 1, max: 1000 } } as const;

/**
 * Apply an admin-issued edit to a card. Runs in a transaction so two
 * concurrent edits or a concurrent punch can't end up with a stale row.
 *
 * Behavioral notes:
 * - Lowering totalEntries below usedEntries → rejected (`total_below_used`).
 *   The admin must refund entries first to free capacity.
 * - Raising totalEntries above usedEntries on a card that had auto-
 *   deactivated due to exhaustion (isActive=false, cancelledAt=null) →
 *   reactivates the card.
 * - Setting totalEntries == usedEntries → deactivates the card (matches
 *   the punch-time exhaustion behavior).
 * - expiresAt=null is the "forever" sentinel, matching createPunchCard's
 *   convention.
 * - A no-op patch returns `no_changes` so the route layer can surface it.
 */
export const editCard = async (
  db: AnyPgDatabase,
  input: EditCardInput,
): Promise<EditCardResult> => {
  const now = input.now ?? new Date();
  if (
    input.totalEntries !== undefined &&
    (!Number.isInteger(input.totalEntries) ||
      input.totalEntries < editCardRange.totalEntries.min ||
      input.totalEntries > editCardRange.totalEntries.max)
  ) {
    return { ok: false, reason: 'total_out_of_range' };
  }

  return db.transaction(async (tx) => {
    const cardRows = await tx
      .select()
      .from(punchCards)
      .where(eq(punchCards.id, input.cardId))
      .for('update')
      .limit(1);
    const card = cardRows[0];
    if (!card) return { ok: false, reason: 'card_not_found' };
    if (card.cancelledAt) return { ok: false, reason: 'card_cancelled' };

    if (input.totalEntries !== undefined && input.totalEntries < card.usedEntries) {
      return { ok: false, reason: 'total_below_used', usedEntries: card.usedEntries };
    }

    const next: Partial<typeof punchCards.$inferInsert> = {};
    const diff: Record<string, [unknown, unknown]> = {};

    if (input.totalEntries !== undefined && input.totalEntries !== card.totalEntries) {
      next.totalEntries = input.totalEntries;
      diff.totalEntries = [card.totalEntries, input.totalEntries];
    }
    if (input.source !== undefined && input.source !== card.source) {
      next.source = input.source;
      diff.source = [card.source, input.source];
    }
    if (input.expiresAt !== undefined) {
      // Compare with the existing value semantically: null vs null are equal.
      const currentMs = card.expiresAt ? card.expiresAt.getTime() : null;
      const nextMs = input.expiresAt ? input.expiresAt.getTime() : null;
      if (currentMs !== nextMs) {
        next.expiresAt = input.expiresAt;
        diff.expiresAt = [card.expiresAt, input.expiresAt];
      }
    }

    if (Object.keys(diff).length === 0) return { ok: false, reason: 'no_changes' };

    // Resolve reactivation / deactivation from the new totalEntries.
    const effectiveTotal = next.totalEntries ?? card.totalEntries;
    let isActive = card.isActive;
    let reactivated = false;
    if (effectiveTotal > card.usedEntries && !card.isActive && card.cancelledAt === null) {
      isActive = true;
      reactivated = true;
    }
    if (effectiveTotal <= card.usedEntries && card.isActive) {
      // Exhausted by the edit.
      isActive = false;
    }
    if (isActive !== card.isActive) next.isActive = isActive;

    next.updatedAt = now;

    const updated = await tx
      .update(punchCards)
      .set(next)
      .where(eq(punchCards.id, card.id))
      .returning();
    const row = updated[0];
    if (!row) return { ok: false, reason: 'card_not_found' };

    await logStaffAction(tx, {
      action: 'edit_card',
      summary: summarizeEditDiff(card.serialNumber, diff, reactivated),
      now,
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
    });

    return { ok: true, card: row, diff, reactivated };
  });
};

// Hebrew-facing summary line for the staff_actions log. e.g.
// "עריכת כרטיסייה M-20260620-0001 · כניסות 12→24 · תוקף ללא תפוגה"
const summarizeEditDiff = (
  serial: string,
  diff: Record<string, [unknown, unknown]>,
  reactivated: boolean,
): string => {
  const parts: string[] = [];
  if (diff.totalEntries) parts.push(`כניסות ${diff.totalEntries[0]}→${diff.totalEntries[1]}`);
  if (diff.expiresAt) {
    const to = diff.expiresAt[1];
    const toLabel =
      to === null
        ? 'ללא תפוגה'
        : to instanceof Date
          ? to.toISOString().slice(0, 10)
          : String(to);
    parts.push(`תוקף ${toLabel}`);
  }
  if (diff.source) parts.push(`מקור ${diff.source[0]}→${diff.source[1]}`);
  if (reactivated) parts.push('הופעלה מחדש');
  return `עריכת כרטיסייה ${serial} · ${parts.join(' · ')}`;
};
