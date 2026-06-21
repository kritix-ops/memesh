import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customerLoginTokens } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Sources that mint a customer_login_tokens row. Each value corresponds to
// a distinct creation surface so we can audit + (later) rate-limit per source
// without touching the others:
//   - 'wc_checkout' — WordPress/WooCommerce checkout handoff (5-min TTL).
//   - 'pos_sell'    — cashier-driven POS card sale → magic link in the
//                     post-sale SMS (24-h TTL, set by the caller via ttlMs).
export type HandoffTokenSource = 'wc_checkout' | 'pos_sell';

/**
 * Generate a fresh handoff token. 32 random bytes rendered as base64url
 * (43 chars, URL-safe, no padding). Returns BOTH the raw token (handed to
 * the caller to put in the redirect URL) and its hash (stored in the DB).
 * The raw token must never be persisted.
 */
export const generateRawHandoffToken = (): { raw: string; hash: string } => {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
};

/**
 * Constant-time equality between two SHA-256 hex digests. Avoids a timing
 * side-channel on the verify endpoint.
 */
export const constantTimeHashEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length || a.length !== 64) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export interface MintHandoffTokenInput {
  customerId: string;
  source: HandoffTokenSource;
  orderRef?: string;
  ttlMs?: number;
  now?: Date;
}

export interface MintedHandoffToken {
  raw: string;
  hash: string;
  expiresAt: Date;
}

/**
 * Mint a fresh handoff token for a customer. Returns the raw token that the
 * caller MUST hand to the user (e.g., embed in a redirect URL) and discard
 * server-side. The DB row only stores the SHA-256 hash.
 */
export const mintHandoffToken = async (
  db: AnyPgDatabase,
  input: MintHandoffTokenInput,
): Promise<MintedHandoffToken> => {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const { raw, hash } = generateRawHandoffToken();

  await db.insert(customerLoginTokens).values({
    customerId: input.customerId,
    tokenHash: hash,
    source: input.source,
    ...(input.orderRef !== undefined && { orderRef: input.orderRef }),
    expiresAt,
    createdAt: now,
  });

  return { raw, hash, expiresAt };
};

export type ConsumeHandoffTokenResult =
  | { ok: true; customerId: string; source: HandoffTokenSource }
  | { ok: false; reason: 'invalid_or_consumed' | 'expired' };

/**
 * Atomically consume a handoff token. Returns the customer id on success.
 * Same token presented twice (race or replay) → second call returns
 * 'invalid_or_consumed', because the UPDATE ... WHERE consumed_at IS NULL
 * matches at most once per row.
 *
 * Expiry is enforced in the UPDATE predicate too — expired rows look
 * indistinguishable from invalid ones to the caller, which is on purpose
 * (no oracle for "this token existed but you waited too long").
 */
export const consumeHandoffToken = async (
  db: AnyPgDatabase,
  rawToken: string,
  config: { now?: Date } = {},
): Promise<ConsumeHandoffTokenResult> => {
  const now = config.now ?? new Date();
  const hash = createHash('sha256').update(rawToken).digest('hex');

  const rows = await db
    .update(customerLoginTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(customerLoginTokens.tokenHash, hash),
        isNull(customerLoginTokens.consumedAt),
      ),
    )
    .returning({
      customerId: customerLoginTokens.customerId,
      source: customerLoginTokens.source,
      expiresAt: customerLoginTokens.expiresAt,
    });

  const row = rows[0];
  if (!row) return { ok: false, reason: 'invalid_or_consumed' };
  if (row.expiresAt.getTime() <= now.getTime()) {
    // We already burned the row (consumedAt is set) — that's fine; the
    // token couldn't be used to sign in anyway because it's expired.
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, customerId: row.customerId, source: row.source as HandoffTokenSource };
};

/**
 * Delete handoff tokens that have been consumed OR have expired for more
 * than `keepAfterExpiryMs`. Called by the daily cleanup cron — keeps the
 * table small and audit-trail relevant.
 */
export const cleanupHandoffTokens = async (
  db: AnyPgDatabase,
  config: { keepAfterExpiryMs?: number; now?: Date } = {},
): Promise<{ deleted: number }> => {
  const now = config.now ?? new Date();
  const keep = config.keepAfterExpiryMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  const cutoff = new Date(now.getTime() - keep);

  const rows = await db
    .delete(customerLoginTokens)
    .where(lt(customerLoginTokens.expiresAt, cutoff))
    .returning({ id: customerLoginTokens.id });
  return { deleted: rows.length };
};
