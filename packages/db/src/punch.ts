import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { punchCardEntries, punchCards, scanAttempts } from './schema/index';

export type PunchMethod = 'qr_scan' | 'serial' | 'phone' | 'manual';
export type PunchFailureReason = 'not_found' | 'inactive' | 'expired' | 'exhausted';

const COMPANION_MIN = 1;
const COMPANION_MAX = 4;

export interface PunchAudit {
  qrTokenHash?: string;
  ipAddress?: string;
  terminalId?: string;
}

export interface PunchInput {
  punchCardId: string;
  punchedBy?: string; // staff id; null for online/system punches
  method: PunchMethod;
  companionCount?: number; // recorded only; one punch always consumes one entry
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
      usedEntries: number;
      totalEntries: number;
      remaining: number;
    }
  | { ok: false; reason: PunchFailureReason };

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
// The function references schema tables directly, so the schema generic is not needed here.
type AnyPgDatabase = PgDatabase<any, any, any>;

type AuditResult = 'success' | PunchFailureReason;

const clampCompanions = (n: number): number => {
  if (!Number.isFinite(n)) return COMPANION_MIN;
  return Math.min(COMPANION_MAX, Math.max(COMPANION_MIN, Math.trunc(n)));
};

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
  const companionCount = clampCompanions(input.companionCount ?? COMPANION_MIN);

  return db.transaction(async (tx) => {
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

    // Idempotent replay: this key already punched, so do not punch again.
    if (input.idempotencyKey) {
      const priorRows = await tx
        .select({
          id: punchCardEntries.id,
          punchCardId: punchCardEntries.punchCardId,
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
          usedEntries: card.usedEntries,
          totalEntries: card.totalEntries,
          remaining: card.totalEntries - card.usedEntries,
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
    if (card.expiresAt.getTime() <= now.getTime()) {
      await writeAudit('expired');
      return { ok: false, reason: 'expired' };
    }
    if (card.usedEntries >= card.totalEntries) {
      await writeAudit('exhausted');
      return { ok: false, reason: 'exhausted' };
    }

    const nextUsed = card.usedEntries + 1;
    const exhausted = nextUsed >= card.totalEntries;

    const insertedRows = await tx
      .insert(punchCardEntries)
      .values({
        punchCardId: card.id,
        punchedBy: input.punchedBy ?? null,
        method: input.method,
        companionCount,
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
      usedEntries: nextUsed,
      totalEntries: card.totalEntries,
      remaining: card.totalEntries - nextUsed,
    };
  });
}
