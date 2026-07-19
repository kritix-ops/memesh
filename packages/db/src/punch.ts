import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { logStaffAction } from './actions';
import { getCardSettings } from './card-settings';
import { punchCardEntries, punchCards, scanAttempts } from './schema/index';

export type PunchMethod = 'qr_scan' | 'serial' | 'phone' | 'manual' | 'online';
export type PunchFailureReason =
  | 'not_found'
  | 'inactive'
  | 'expired'
  | 'exhausted'
  | 'locked_out'
  | 'entries_out_of_range';

export interface PunchAudit {
  qrTokenHash?: string;
  ipAddress?: string;
  terminalId?: string;
}

export interface PunchInput {
  punchCardId: string;
  punchedBy?: string; // staff id; null for online/system punches
  method: PunchMethod;
  /** How many entries this single scan should consume. Defaults to 1. Server
   *  caps it at the card's remaining entries inside the locked transaction. */
  entries?: number;
  idempotencyKey?: string; // a repeat with the same key is a no-op, not a double punch
  notes?: string;
  audit?: PunchAudit;
  now?: Date; // injectable clock for testing
}

export type PunchResult =
  | {
      ok: true;
      replay: boolean; // true when an idempotency key matched an earlier punch
      entryId: string;
      /** How many entries this scan actually consumed (echo of the input). */
      entriesConsumed: number;
      usedEntries: number;
      totalEntries: number;
      remaining: number;
      /** True when the card was past expiresAt but within the configured grace window. */
      grace: boolean;
    }
  | {
      ok: false;
      reason: PunchFailureReason;
      /** Present for `locked_out`: how many minutes until the next punch is allowed. */
      retryAfterMinutes?: number;
      /** Present for `entries_out_of_range`: the range the cashier could have picked
       *  given the card's remaining entries at scan time. */
      allowedRange?: { min: number; max: number };
    };

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
// The function references schema tables directly, so the schema generic is not needed here.
type AnyPgDatabase = PgDatabase<any, any, any>;

// The scan_attempts.result enum is narrower than PunchFailureReason — some
// failure modes (entries_out_of_range) don't get audited at all, and
// locked_out maps to the existing 'rate_limited' enum value.
type AuditResult =
  | 'success'
  | 'not_found'
  | 'inactive'
  | 'expired'
  | 'exhausted'
  | 'rate_limited';

/**
 * Atomically punch one entry on a card.
 *
 * The whole operation runs in a single transaction and locks the card row with
 * SELECT ... FOR UPDATE, so two simultaneous scans of the same card cannot both
 * succeed and over-draw it. Every attempt (success or failure) writes a
 * scan_attempts audit row inside the same transaction.
 */
export async function punchCard(db: AnyPgDatabase, input: PunchInput): Promise<PunchResult> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    // Settings drive lockout window + grace period. Read once per call (inside
    // the tx so a concurrent settings update is consistent).
    const settings = await getCardSettings(tx);

    // Default to 1 entry per scan when the cashier doesn't pick. Math.trunc()
    // defends against fractional values arriving from a buggy client.
    const requestedEntries = Math.trunc(input.entries ?? 1);

    const writeAudit = async (result: AuditResult): Promise<void> => {
      await tx.insert(scanAttempts).values({
        qrTokenHash: input.audit?.qrTokenHash ?? null,
        result,
        ipAddress: input.audit?.ipAddress ?? null,
        terminalId: input.audit?.terminalId ?? null,
        attemptedAt: now,
      });
    };

    const lockCard = async (id: string) => {
      const rows = await tx
        .select()
        .from(punchCards)
        .where(eq(punchCards.id, id))
        .for('update')
        .limit(1);
      return rows[0];
    };

    // Cheap upfront check: entries must be a positive integer. The
    // remaining-entries bound check needs the locked card row and runs below.
    // Not audited to scan_attempts: this is a cashier-side UX validation, not
    // a security event.
    if (!Number.isFinite(requestedEntries) || requestedEntries < 1) {
      return {
        ok: false,
        reason: 'entries_out_of_range',
        allowedRange: { min: 1, max: 1 },
      };
    }

    // Idempotent replay: this key already punched, so do not punch again.
    // The original `entriesConsumed` from the first call is the source of
    // truth — the replay echoes it so the client renders the same outcome.
    if (input.idempotencyKey) {
      const priorRows = await tx
        .select({
          id: punchCardEntries.id,
          punchCardId: punchCardEntries.punchCardId,
          entriesConsumed: punchCardEntries.entriesConsumed,
        })
        .from(punchCardEntries)
        .where(eq(punchCardEntries.idempotencyKey, input.idempotencyKey))
        .limit(1);
      const prior = priorRows[0];
      if (prior) {
        const card = await lockCard(prior.punchCardId);
        await writeAudit('success');
        if (!card) {
          return { ok: false, reason: 'not_found' };
        }
        return {
          ok: true,
          replay: true,
          entryId: prior.id,
          entriesConsumed: prior.entriesConsumed,
          usedEntries: card.usedEntries,
          totalEntries: card.totalEntries,
          remaining: card.totalEntries - card.usedEntries,
          grace: false,
        };
      }
    }

    const card = await lockCard(input.punchCardId);
    if (!card) {
      await writeAudit('not_found');
      return { ok: false, reason: 'not_found' };
    }
    if (!card.isActive) {
      await writeAudit('inactive');
      return { ok: false, reason: 'inactive' };
    }

    // Expiry with grace: card is past expiresAt → if within grace, accept and
    // flag `grace: true` on the success result. Past grace → hard fail.
    // `expiresAt: null` is a "forever" card (validityDays=0); no expiry check.
    let inGrace = false;
    if (card.expiresAt !== null) {
      const expiresMs = card.expiresAt.getTime();
      const graceCutoffMs = expiresMs + settings.gracePeriodDays * 24 * 60 * 60 * 1000;
      if (expiresMs <= now.getTime()) {
        if (now.getTime() <= graceCutoffMs) {
          inGrace = true;
        } else {
          await writeAudit('expired');
          return { ok: false, reason: 'expired' };
        }
      }
    }

    if (card.usedEntries >= card.totalEntries) {
      await writeAudit('exhausted');
      return { ok: false, reason: 'exhausted' };
    }

    // Bound the requested entries by what's still on the card. This is what
    // makes "cashier picks N at scan time" safe — two concurrent scans cannot
    // both succeed and over-draw because the card row is locked above. Not
    // audited: the cashier saw a bad number and we tell them what's allowed.
    const remainingBefore = card.totalEntries - card.usedEntries;
    if (requestedEntries > remainingBefore) {
      return {
        ok: false,
        reason: 'entries_out_of_range',
        allowedRange: { min: 1, max: remainingBefore },
      };
    }

    // Same-day lockout: if the most recent successful entry on this card is
    // within `sameDayLockoutMinutes`, refuse. Disabled (0) skips the query.
    if (settings.sameDayLockoutMinutes > 0) {
      const lastRows = await tx
        .select({ punchedAt: punchCardEntries.punchedAt })
        .from(punchCardEntries)
        .where(eq(punchCardEntries.punchCardId, card.id))
        .orderBy(desc(punchCardEntries.punchedAt))
        .limit(1);
      const last = lastRows[0];
      if (last) {
        const elapsedMin = (now.getTime() - last.punchedAt.getTime()) / 60000;
        if (elapsedMin < settings.sameDayLockoutMinutes) {
          await writeAudit('rate_limited');
          return {
            ok: false,
            reason: 'locked_out',
            retryAfterMinutes: Math.ceil(settings.sameDayLockoutMinutes - elapsedMin),
          };
        }
      }
    }

    const nextUsed = card.usedEntries + requestedEntries;
    const exhausted = nextUsed >= card.totalEntries;

    const insertedRows = await tx
      .insert(punchCardEntries)
      .values({
        punchCardId: card.id,
        punchedBy: input.punchedBy ?? null,
        method: input.method,
        entriesConsumed: requestedEntries,
        idempotencyKey: input.idempotencyKey ?? null,
        notes: input.notes ?? null,
        punchedAt: now,
      })
      .returning({ id: punchCardEntries.id });

    await tx
      .update(punchCards)
      .set({ usedEntries: nextUsed, isActive: !exhausted, updatedAt: now })
      .where(eq(punchCards.id, card.id));

    await writeAudit('success');

    const inserted = insertedRows[0];
    if (!inserted) {
      throw new Error('[punch] entry insert returned no row');
    }

    return {
      ok: true,
      replay: false,
      entryId: inserted.id,
      entriesConsumed: requestedEntries,
      usedEntries: nextUsed,
      totalEntries: card.totalEntries,
      remaining: card.totalEntries - nextUsed,
      grace: inGrace,
    };
  });
}

// ---------------------------------------------------------------------------
// refundEntry — reverse a single punch, decrementing usedEntries and
// reactivating the card if it had been deactivated by exhaustion.
// ---------------------------------------------------------------------------

export type RefundEntryFailure =
  | 'entry_not_found'
  | 'already_refunded'
  | 'card_cancelled';

export interface RefundEntryInput {
  entryId: string;
  /** Cashier (or admin) who initiated the refund. */
  refundedBy: string;
  /** Admin whose password authorized it. Same as refundedBy when admin self-served. */
  approvedBy: string;
  reason: string;
  now?: Date;
}

export type RefundEntryResult =
  | {
      ok: true;
      entryId: string;
      cardId: string;
      usedEntries: number;
      totalEntries: number;
      remaining: number;
      reactivated: boolean;
    }
  | { ok: false; reason: RefundEntryFailure };

/**
 * Refund an entry: mark it refunded, decrement usedEntries on the card, and
 * reactivate the card if it had been auto-deactivated by exhaustion. Runs in
 * a single transaction with a row lock on the card so two concurrent refunds
 * cannot under-draw the counter.
 *
 * Refusals:
 * - entry_not_found: no entry with that id
 * - already_refunded: refundedAt already set
 * - card_cancelled: the underlying card was cancelled — refunding entries on a
 *   cancelled card doesn't make business sense (cashier should cancel/refund
 *   the whole card or contact the customer)
 */
export async function refundEntry(
  db: AnyPgDatabase,
  input: RefundEntryInput,
): Promise<RefundEntryResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const entryRows = await tx
      .select()
      .from(punchCardEntries)
      .where(eq(punchCardEntries.id, input.entryId))
      .limit(1);
    const entry = entryRows[0];
    if (!entry) return { ok: false, reason: 'entry_not_found' };
    if (entry.refundedAt) return { ok: false, reason: 'already_refunded' };

    // Lock the card row to serialize with concurrent punches/refunds.
    const cardRows = await tx
      .select()
      .from(punchCards)
      .where(eq(punchCards.id, entry.punchCardId))
      .for('update')
      .limit(1);
    const card = cardRows[0];
    if (!card) return { ok: false, reason: 'entry_not_found' };
    if (card.cancelledAt) return { ok: false, reason: 'card_cancelled' };

    // Atomically flip the entry to refunded. The `refunded_at IS NULL` guard is
    // what actually prevents a concurrent refund/cancel on the SAME entry from
    // both crediting a punch back (TOCTOU): the pre-lock `entry.refundedAt` read
    // above is only a fast-path, not a guard. If another actor already refunded
    // this entry, the UPDATE matches 0 rows and we stop before touching the card.
    const flipped = await tx
      .update(punchCardEntries)
      .set({
        refundedAt: now,
        refundedBy: input.refundedBy,
        approvedBy: input.approvedBy,
        refundReason: input.reason,
      })
      .where(and(eq(punchCardEntries.id, entry.id), isNull(punchCardEntries.refundedAt)))
      .returning({ id: punchCardEntries.id });
    if (flipped.length === 0) return { ok: false, reason: 'already_refunded' };

    // Only now credit the card, exactly once. Restore what this row consumed —
    // single-entry scans give back 1, multi-entry scans give back N. Clamp at
    // zero defensively. Reactivate only if exhaustion was why the card went
    // inactive (no cancelledAt); an already-active card stays active.
    const nextUsed = Math.max(0, card.usedEntries - entry.entriesConsumed);
    const reactivated = !card.isActive && card.cancelledAt === null;

    await tx
      .update(punchCards)
      .set({
        usedEntries: nextUsed,
        ...(reactivated && { isActive: true }),
        updatedAt: now,
      })
      .where(eq(punchCards.id, card.id));

    await logStaffAction(tx, {
      action: 'refund_entry',
      summary: `החזר כניסה · ${card.serialNumber}${input.refundedBy !== input.approvedBy ? ' (אושר ע"י אדמין)' : ''} · סיבה: ${input.reason}`,
      staffId: input.refundedBy,
      now,
    });

    return {
      ok: true,
      entryId: entry.id,
      cardId: card.id,
      usedEntries: nextUsed,
      totalEntries: card.totalEntries,
      remaining: card.totalEntries - nextUsed,
      reactivated,
    };
  });
}
