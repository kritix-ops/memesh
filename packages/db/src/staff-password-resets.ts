import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { staffPasswordResets } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes — long enough for email delivery + read, short enough to limit replay
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // keep expired rows 7 days for audit

/**
 * Generate a fresh password-reset token. 32 random bytes rendered as
 * base64url (43 chars, URL-safe, no padding) — 256 bits of entropy.
 * Returns BOTH the raw token (sent in the email URL) and its SHA-256 hash
 * (stored in the DB). The raw token MUST NOT be persisted anywhere.
 *
 * Same shape as handoff-tokens.generateRawHandoffToken so any future audit
 * pass can apply one rule to all single-use bearer tokens in this codebase.
 */
const generateRawResetToken = (): { raw: string; hash: string } => {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
};

export interface MintStaffPasswordResetInput {
  staffId: string;
  ttlMs?: number;
  now?: Date;
}

export interface MintedStaffPasswordReset {
  raw: string;
  hash: string;
  expiresAt: Date;
}

/**
 * Mint a fresh password-reset token for a staff member. Returns the raw
 * token that the caller MUST embed in the reset URL and then discard
 * server-side. The DB row only stores the SHA-256 hash.
 */
export const mintStaffPasswordReset = async (
  db: AnyPgDatabase,
  input: MintStaffPasswordResetInput,
): Promise<MintedStaffPasswordReset> => {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const { raw, hash } = generateRawResetToken();

  await db.insert(staffPasswordResets).values({
    staffId: input.staffId,
    tokenHash: hash,
    expiresAt,
    createdAt: now,
  });

  return { raw, hash, expiresAt };
};

export type ConsumeStaffPasswordResetResult =
  | { ok: true; staffId: string }
  | { ok: false; reason: 'invalid_or_consumed' | 'expired' };

/**
 * Atomically consume a reset token. Returns the staff id on success. Same
 * token presented twice (replay or race) → second call returns
 * 'invalid_or_consumed' because UPDATE ... WHERE consumed_at IS NULL
 * matches at most once per row.
 *
 * Expiry is enforced after the burn, on the returned row, so a caller can
 * never use an expired token to sign in — but the row is still consumed
 * (defense in depth: no second chances if the row was found at all).
 */
export const consumeStaffPasswordReset = async (
  db: AnyPgDatabase,
  rawToken: string,
  config: { now?: Date } = {},
): Promise<ConsumeStaffPasswordResetResult> => {
  const now = config.now ?? new Date();
  const hash = createHash('sha256').update(rawToken).digest('hex');

  const rows = await db
    .update(staffPasswordResets)
    .set({ consumedAt: now })
    .where(
      and(
        eq(staffPasswordResets.tokenHash, hash),
        isNull(staffPasswordResets.consumedAt),
      ),
    )
    .returning({
      staffId: staffPasswordResets.staffId,
      expiresAt: staffPasswordResets.expiresAt,
    });

  const row = rows[0];
  if (!row) return { ok: false, reason: 'invalid_or_consumed' };
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, staffId: row.staffId };
};

/**
 * Burn every outstanding (unconsumed) reset token for a staff member. Called
 * after a successful password reset so that any leaked-but-unused token is
 * neutralized — the legitimate user beat the attacker to it, and we want to
 * make sure the attacker can't use their stolen copy later.
 *
 * Returns the number of tokens that were just consumed.
 */
export const invalidateStaffPasswordResets = async (
  db: AnyPgDatabase,
  staffId: string,
  now: Date = new Date(),
): Promise<{ invalidated: number }> => {
  const rows = await db
    .update(staffPasswordResets)
    .set({ consumedAt: now })
    .where(
      and(eq(staffPasswordResets.staffId, staffId), isNull(staffPasswordResets.consumedAt)),
    )
    .returning({ id: staffPasswordResets.id });
  return { invalidated: rows.length };
};

/**
 * Count outstanding (unconsumed, unexpired) reset tokens for a staff
 * member. The forgot-password route uses this to enforce a per-user
 * cooldown (don't mint a second token when a fresh one is still valid).
 */
export const countActiveStaffPasswordResets = async (
  db: AnyPgDatabase,
  staffId: string,
  now: Date = new Date(),
): Promise<number> => {
  const rows = await db
    .select({ id: staffPasswordResets.id, expiresAt: staffPasswordResets.expiresAt })
    .from(staffPasswordResets)
    .where(
      and(eq(staffPasswordResets.staffId, staffId), isNull(staffPasswordResets.consumedAt)),
    );
  return rows.filter((r) => r.expiresAt.getTime() > now.getTime()).length;
};

/**
 * Delete reset-token rows that have expired more than `keepAfterExpiryMs`
 * ago. Called by the daily cleanup cron — keeps the table small and the
 * audit trail relevant. Mirrors `cleanupHandoffTokens`.
 */
export const cleanupStaffPasswordResets = async (
  db: AnyPgDatabase,
  config: { keepAfterExpiryMs?: number; now?: Date } = {},
): Promise<{ deleted: number }> => {
  const now = config.now ?? new Date();
  const keep = config.keepAfterExpiryMs ?? DEFAULT_RETENTION_MS;
  const cutoff = new Date(now.getTime() - keep);

  const rows = await db
    .delete(staffPasswordResets)
    .where(lt(staffPasswordResets.expiresAt, cutoff))
    .returning({ id: staffPasswordResets.id });
  return { deleted: rows.length };
};
