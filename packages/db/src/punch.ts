import { desc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getCardSettings } from './card-settings';
import { punchCardEntries, punchCards, scanAttempts } from './schema/index';

export type PunchMethod = 'qr_scan' | 'serial' | 'phone' | 'manual';
export type PunchFailureReason =
  | 'not_found'
  | 'inactive'
  | 'expired'
  | 'exhausted'
  | 'locked_out'
  | 'companions_out_of_range';

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
      /** True when the card was past expiresAt but within the configured grace window. */
      grace: boolean;
    }
  | {
      ok: false;
      reason: PunchFailureReason;
      /** Present for `locked_out`: how many minutes until the next punch is allowed. */
      retryAfterMinutes?: number;
      /** Present for `companions_out_of_range`: the active min/max range from settings. */
      allowedRange?: { min: number; max: number };
    };

// Accept any PostgreSQL Drizzle database (node-postgres in prod, PGlite in tests).
// The function references schema tables directly, so the schema generic is not needed here.
type AnyPgDatabase = PgDatabase<any, any, any>;

// The scan_attempts.result enum is narrower than PunchFailureReason — some
// failure modes (companions_out_of_range) don't get audited at all, and
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
    // Settings drive companion limits, lockout window, and grace period. Read
    // once per call (inside the tx so a concurrent settings update is consistent).
    const settings = await getCardSettings(tx);
    const requestedCompanions = Math.trunc(input.companionCount ?? settings.minCompanions);

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

    // Companion validation against the configured range. Fail fast — no point
    // even reading the card if the cashier picked an out-of-range count.
    // Not audited to scan_attempts: this is a cashier-side UX validation, not
    // a security event.
    if (
      !Number.isFinite(requestedCompanions) ||
      requestedCompanions < settings.minCompanions ||
      requestedCompanions > settings.maxCompanions
    ) {
      return {
        ok: false,
        reason: 'companions_out_of_range',
        allowedRange: { min: settings.minCompanions, max: settings.maxCompanions },
      };
    }

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
    const expiresMs = card.expiresAt.getTime();
    const graceCutoffMs = expiresMs + settings.gracePeriodDays * 24 * 60 * 60 * 1000;
    let inGrace = false;
    if (expiresMs <= now.getTime()) {
      if (now.getTime() <= graceCutoffMs) {
        inGrace = true;
      } else {
        await writeAudit('expired');
        return { ok: false, reason: 'expired' };
      }
    }

    if (card.usedEntries >= card.totalEntries) {
      await writeAudit('exhausted');
      return { ok: false, reason: 'exhausted' };
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

    const nextUsed = card.usedEntries + 1;
    const exhausted = nextUsed >= card.totalEntries;

    const insertedRows = await tx
      .insert(punchCardEntries)
      .values({
        punchCardId: card.id,
        punchedBy: input.punchedBy ?? null,
        method: input.method,
        companionCount: requestedCompanions,
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
      grace: inGrace,
    };
  });
}
