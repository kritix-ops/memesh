import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customerOtps, customers } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5; // wrong-code guesses before the code locks
const RESEND_COOLDOWN_MS = 60 * 1000; // min gap between sends to one phone
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 3; // sends per phone per window

export interface OtpConfig {
  pepper: string; // server secret; keeps stored hashes useless without it
  now?: Date;
}

const hashCode = (code: string, phone: string, pepper: string): string =>
  createHmac('sha256', pepper).update(`${phone}:${code}`).digest('hex');

const generateCode = (): string => String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

export type RequestOtpResult =
  // `code` is returned ONLY so the caller can hand it to the SMS provider; it is
  // never logged or stored in plaintext.
  | { sent: true; code: string }
  | { sent: false; reason: 'cooldown' | 'rate_limited' | 'no_customer' };

/**
 * Issue an OTP for a phone, but only if a customer with that phone exists (so the
 * endpoint cannot be used to spam SMS to arbitrary numbers). Enforces a per-phone
 * cooldown and a per-window cap. The caller always responds the same regardless of
 * the reason, so customer existence is never revealed.
 */
export const requestOtp = async (
  db: AnyPgDatabase,
  phone: string,
  config: OtpConfig,
): Promise<RequestOtpResult> => {
  const now = config.now ?? new Date();

  const customer = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.phone, phone))
    .limit(1);
  if (!customer[0]) return { sent: false, reason: 'no_customer' };

  const recent = await db
    .select()
    .from(customerOtps)
    .where(eq(customerOtps.phone, phone))
    .orderBy(desc(customerOtps.createdAt))
    .limit(MAX_PER_WINDOW);

  const last = recent[0];
  if (last && now.getTime() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  const inWindow = recent.filter((r) => now.getTime() - r.createdAt.getTime() < WINDOW_MS);
  if (inWindow.length >= MAX_PER_WINDOW) {
    return { sent: false, reason: 'rate_limited' };
  }

  const code = generateCode();
  await db.insert(customerOtps).values({
    phone,
    codeHash: hashCode(code, phone, config.pepper),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    createdAt: now,
  });
  return { sent: true, code };
};

export type VerifyOtpResult =
  | { ok: true; customerId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'locked' | 'no_customer' };

/**
 * Verify a submitted code against the latest unconsumed OTP for the phone.
 * Counts attempts (locks after MAX_ATTEMPTS), enforces expiry, is single-use, and
 * compares in constant time. On success, resolves the customer id for the session.
 */
export const verifyOtp = async (
  db: AnyPgDatabase,
  phone: string,
  code: string,
  config: OtpConfig,
): Promise<VerifyOtpResult> => {
  const now = config.now ?? new Date();

  const rows = await db
    .select()
    .from(customerOtps)
    .where(and(eq(customerOtps.phone, phone), isNull(customerOtps.consumedAt)))
    .orderBy(desc(customerOtps.createdAt))
    .limit(1);
  const otp = rows[0];
  if (!otp) return { ok: false, reason: 'invalid' };
  if (otp.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  if (otp.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };

  await db
    .update(customerOtps)
    .set({ attempts: otp.attempts + 1 })
    .where(eq(customerOtps.id, otp.id));

  const expected = Buffer.from(hashCode(code, phone, config.pepper), 'hex');
  const actual = Buffer.from(otp.codeHash, 'hex');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!match) return { ok: false, reason: 'invalid' };

  await db.update(customerOtps).set({ consumedAt: now }).where(eq(customerOtps.id, otp.id));

  const customer = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.phone, phone))
    .limit(1);
  if (!customer[0]) return { ok: false, reason: 'no_customer' };
  return { ok: true, customerId: customer[0].id };
};

// ---------------------------------------------------------------------------
// Gift claim OTP — parallel path that does NOT require a pre-existing
// customer row. Used by the gift-card claim flow where the recipient may be
// brand new to Memesh.
//
// Anti-abuse gate is different here: the caller must hold a valid gift
// pending claim token (validated at the route layer) before this path will
// even fire. That's a one-per-order proof, much stronger than "is this
// phone on file" — so we drop the customer-exists check and rely on the
// token instead.
// ---------------------------------------------------------------------------

export type RequestGiftClaimOtpResult =
  | { sent: true; code: string }
  | { sent: false; reason: 'cooldown' | 'rate_limited' };

/**
 * Issue an OTP for the gift-claim flow. The anti-abuse gate (caller must
 * present a valid pending claim token) lives at the route layer; this
 * function only does the OTP insert + the cooldown/rate-limit guards.
 *
 * Uses the same `customer_otps` table so claim OTPs and login OTPs share
 * one rate-limit budget per phone — keeps it tight against attackers and
 * trivial to reason about.
 */
export const requestGiftClaimOtp = async (
  db: AnyPgDatabase,
  phone: string,
  config: OtpConfig,
): Promise<RequestGiftClaimOtpResult> => {
  const now = config.now ?? new Date();

  const recent = await db
    .select()
    .from(customerOtps)
    .where(eq(customerOtps.phone, phone))
    .orderBy(desc(customerOtps.createdAt))
    .limit(MAX_PER_WINDOW);

  const last = recent[0];
  if (last && now.getTime() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  const inWindow = recent.filter((r) => now.getTime() - r.createdAt.getTime() < WINDOW_MS);
  if (inWindow.length >= MAX_PER_WINDOW) {
    return { sent: false, reason: 'rate_limited' };
  }

  const code = generateCode();
  await db.insert(customerOtps).values({
    phone,
    codeHash: hashCode(code, phone, config.pepper),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    createdAt: now,
  });
  return { sent: true, code };
};

export type VerifyGiftClaimOtpResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'expired' | 'locked' };

/**
 * Verify an OTP previously issued via requestGiftClaimOtp. Single-use,
 * constant-time, attempt-counted — same semantics as verifyOtp but without
 * the customer-lookup at the end. The caller already knows which pending
 * claim (and therefore which buyer/recipient identity) this OTP gates.
 */
export const verifyGiftClaimOtp = async (
  db: AnyPgDatabase,
  phone: string,
  code: string,
  config: OtpConfig,
): Promise<VerifyGiftClaimOtpResult> => {
  const now = config.now ?? new Date();

  const rows = await db
    .select()
    .from(customerOtps)
    .where(and(eq(customerOtps.phone, phone), isNull(customerOtps.consumedAt)))
    .orderBy(desc(customerOtps.createdAt))
    .limit(1);
  const otp = rows[0];
  if (!otp) return { ok: false, reason: 'invalid' };
  if (otp.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  if (otp.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };

  await db
    .update(customerOtps)
    .set({ attempts: otp.attempts + 1 })
    .where(eq(customerOtps.id, otp.id));

  const expected = Buffer.from(hashCode(code, phone, config.pepper), 'hex');
  const actual = Buffer.from(otp.codeHash, 'hex');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!match) return { ok: false, reason: 'invalid' };

  await db.update(customerOtps).set({ consumedAt: now }).where(eq(customerOtps.id, otp.id));
  return { ok: true };
};
