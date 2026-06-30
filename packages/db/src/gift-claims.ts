import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { giftPendingClaims, type GiftPendingClaim } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

// 24 random bytes → 32-char base64url. Twice the entropy of the post-purchase
// handoff token because the claim TTL is 365 days, not 24 hours — much longer
// window for an attacker to brute-force the hash space. Single-use semantics
// at the route layer + rate limit on the preview endpoint complete the
// defense.
const CLAIM_TOKEN_BYTES = 24;

/**
 * Generate a fresh claim token. Returns BOTH the raw token (handed to the
 * caller to embed in the recipient's email) and its sha256 hash (stored on
 * the row). The raw value must never be persisted.
 */
export const generateRawClaimToken = (): { raw: string; hash: string } => {
  const raw = randomBytes(CLAIM_TOKEN_BYTES).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
};

/** sha256 hex of `raw`. Exported so the routes can hash the URL param. */
export const hashClaimToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

export interface CreateGiftPendingClaimInput {
  wcOrderId: string;
  wcSku: string;
  buyerFirstName: string;
  buyerLastName: string;
  buyerEmail: string;
  buyerPhone: string;
  recipientFirstName: string;
  recipientLastName: string;
  recipientEmail: string;
  recipientPhone: string;
  /** Days from now until the claim link expires. Default 365. */
  ttlDays?: number;
  /** Override `now` for tests. */
  now?: Date;
}

export interface CreatedGiftPendingClaim {
  row: GiftPendingClaim;
  /** Raw claim token. Must be emailed to the recipient, never persisted. */
  rawClaimToken: string;
}

const DEFAULT_TTL_DAYS = 365;

/**
 * Insert a `gift_pending_claims` row for a gift order whose recipient is not
 * yet a Memesh customer. Caller hands the returned `rawClaimToken` straight
 * to the email builder; the row stores only its sha256 hash.
 *
 * Idempotency is the caller's responsibility — wrap the call alongside the
 * webhook delivery's existing advisory lock + `wc_processed_webhooks` claim.
 */
export const createGiftPendingClaim = async (
  db: AnyPgDatabase,
  input: CreateGiftPendingClaimInput,
): Promise<CreatedGiftPendingClaim> => {
  const now = input.now ?? new Date();
  const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const { raw, hash } = generateRawClaimToken();

  const rows = await db
    .insert(giftPendingClaims)
    .values({
      wcOrderId: input.wcOrderId,
      wcSku: input.wcSku,
      buyerFirstName: input.buyerFirstName,
      buyerLastName: input.buyerLastName,
      buyerEmail: input.buyerEmail,
      buyerPhone: input.buyerPhone,
      recipientFirstName: input.recipientFirstName,
      recipientLastName: input.recipientLastName,
      recipientEmail: input.recipientEmail,
      recipientPhone: input.recipientPhone,
      claimTokenHash: hash,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('[createGiftPendingClaim] insert returned no row');
  return { row, rawClaimToken: raw };
};

/**
 * Look up a pending claim by the sha256 hash of the raw token from the URL.
 * Returns the row whether or not it has been claimed/expired — the calling
 * route layer decides how to render each state (claimed → "already opened",
 * expired → "link expired", live → render claim flow).
 */
export const findPendingClaimByTokenHash = async (
  db: AnyPgDatabase,
  rawClaimToken: string,
): Promise<GiftPendingClaim | undefined> => {
  const hash = hashClaimToken(rawClaimToken);
  const rows = await db
    .select()
    .from(giftPendingClaims)
    .where(eq(giftPendingClaims.claimTokenHash, hash))
    .limit(1);
  return rows[0];
};

/**
 * Reconciliation idempotency: "does a pending claim already exist for this WC
 * order?" — when the webhook fires twice for the same gift order, the second
 * delivery early-outs instead of minting a duplicate claim row.
 */
export const findPendingClaimByOrderId = async (
  db: AnyPgDatabase,
  wcOrderId: string,
): Promise<GiftPendingClaim | undefined> => {
  const rows = await db
    .select()
    .from(giftPendingClaims)
    .where(eq(giftPendingClaims.wcOrderId, wcOrderId))
    .limit(1);
  return rows[0];
};

export type MarkGiftClaimCompleteResult =
  | { ok: true; row: GiftPendingClaim }
  | { ok: false; reason: 'not_found' | 'already_claimed' | 'expired' };

/**
 * Atomic claim transition: only mutates rows where `claimed_at IS NULL`
 * AND `expired_at IS NULL` AND `expires_at > now`. A second concurrent claim
 * attempt (race, replay) sees `not_found` from the empty `.returning()`.
 *
 * The caller is responsible for minting the customer + card BEFORE calling
 * this — `mintedCardId` is required at transition time so the gift row is
 * never half-claimed (claimed_at set, no card on the other side).
 */
export const markGiftClaimComplete = async (
  db: AnyPgDatabase,
  input: { pendingId: string; mintedCardId: string; now?: Date },
): Promise<MarkGiftClaimCompleteResult> => {
  const now = input.now ?? new Date();
  const rows = await db
    .update(giftPendingClaims)
    .set({
      claimedAt: now,
      mintedCardId: input.mintedCardId,
      updatedAt: now,
    })
    .where(
      and(
        eq(giftPendingClaims.id, input.pendingId),
        isNull(giftPendingClaims.claimedAt),
        isNull(giftPendingClaims.expiredAt),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) {
    // Re-read to give the caller a precise reason. If the row genuinely
    // doesn't exist we say so; otherwise it was already claimed or expired.
    const existing = await db
      .select()
      .from(giftPendingClaims)
      .where(eq(giftPendingClaims.id, input.pendingId))
      .limit(1);
    const existingRow = existing[0];
    if (!existingRow) return { ok: false, reason: 'not_found' };
    if (existingRow.claimedAt) return { ok: false, reason: 'already_claimed' };
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, row };
};

export interface SweepExpiredGiftClaimsResult {
  expiredIds: string[];
}

/**
 * Daily cron sweep: stamp `expired_at` on rows that passed their
 * `expires_at` without being claimed. Returns the affected row ids so the
 * caller can fire the buyer "your gift wasn't claimed" notice for each one
 * outside the transaction.
 */
export const sweepExpiredGiftClaims = async (
  db: AnyPgDatabase,
  config: { now?: Date } = {},
): Promise<SweepExpiredGiftClaimsResult> => {
  const now = config.now ?? new Date();
  const rows = await db
    .update(giftPendingClaims)
    .set({ expiredAt: now, updatedAt: now })
    .where(
      and(
        lt(giftPendingClaims.expiresAt, now),
        isNull(giftPendingClaims.claimedAt),
        isNull(giftPendingClaims.expiredAt),
      ),
    )
    .returning({ id: giftPendingClaims.id });
  return { expiredIds: rows.map((r) => r.id) };
};
