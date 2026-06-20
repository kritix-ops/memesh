import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customers, emailOtps } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes — longer than SMS to absorb mail-delivery lag
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 3;

export interface EmailOtpConfig {
  pepper: string; // server secret; keeps stored hashes useless without it
  now?: Date;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const hashCode = (code: string, email: string, pepper: string): string =>
  createHmac('sha256', pepper).update(`${email}:${code}`).digest('hex');

const generateCode = (): string =>
  String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

export type RequestEmailOtpResult =
  // `code` is returned ONLY so the caller can hand it to the email provider; it is
  // never logged or stored in plaintext.
  | { sent: true; code: string; firstName: string }
  | { sent: false; reason: 'cooldown' | 'rate_limited' | 'no_customer' };

/**
 * Issue an email OTP only when the email is on file as a customer.email. The
 * route layer always responds the same regardless of reason so the endpoint
 * never reveals whether the email is known. Per-email cooldown + per-window
 * cap mirror the SMS flow in otp.ts.
 *
 * Returns the customer's firstName on success so the caller can render it into
 * the email body template ({{firstName}} placeholder).
 */
export const requestEmailOtp = async (
  db: AnyPgDatabase,
  rawEmail: string,
  config: EmailOtpConfig,
): Promise<RequestEmailOtpResult> => {
  const email = normalizeEmail(rawEmail);
  const now = config.now ?? new Date();

  const customer = await db
    .select({ id: customers.id, firstName: customers.firstName })
    .from(customers)
    .where(eq(customers.email, email))
    .limit(1);
  if (!customer[0]) return { sent: false, reason: 'no_customer' };

  const recent = await db
    .select()
    .from(emailOtps)
    .where(eq(emailOtps.email, email))
    .orderBy(desc(emailOtps.createdAt))
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
  await db.insert(emailOtps).values({
    email,
    codeHash: hashCode(code, email, config.pepper),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    createdAt: now,
  });
  return { sent: true, code, firstName: customer[0].firstName };
};

export type VerifyEmailOtpResult =
  | { ok: true; customerId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'locked' | 'no_customer' };

/**
 * Verify a submitted code against the latest unconsumed OTP for the email.
 * Single-use, constant-time compare, attempt-counted (locks after MAX_ATTEMPTS),
 * expiry-enforced. On success resolves the customer id for the session.
 */
export const verifyEmailOtp = async (
  db: AnyPgDatabase,
  rawEmail: string,
  code: string,
  config: EmailOtpConfig,
): Promise<VerifyEmailOtpResult> => {
  const email = normalizeEmail(rawEmail);
  const now = config.now ?? new Date();

  const rows = await db
    .select()
    .from(emailOtps)
    .where(and(eq(emailOtps.email, email), isNull(emailOtps.consumedAt)))
    .orderBy(desc(emailOtps.createdAt))
    .limit(1);
  const otp = rows[0];
  if (!otp) return { ok: false, reason: 'invalid' };
  if (otp.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  if (otp.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };

  await db
    .update(emailOtps)
    .set({ attempts: otp.attempts + 1 })
    .where(eq(emailOtps.id, otp.id));

  const expected = Buffer.from(hashCode(code, email, config.pepper), 'hex');
  const actual = Buffer.from(otp.codeHash, 'hex');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!match) return { ok: false, reason: 'invalid' };

  await db.update(emailOtps).set({ consumedAt: now }).where(eq(emailOtps.id, otp.id));

  const customer = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, email))
    .limit(1);
  if (!customer[0]) return { ok: false, reason: 'no_customer' };
  return { ok: true, customerId: customer[0].id };
};

/**
 * Render the email body template by substituting {{firstName}} and {{code}}.
 * Rejects unknown placeholders so a typo in the admin Settings page surfaces
 * at save time instead of breaking every OTP that follows.
 */
export const renderEmailOtpBody = (
  template: string,
  vars: { firstName: string | null; code: string },
): string => {
  const firstName = (vars.firstName ?? '').trim() || 'לקוח/ה';
  return template
    .replaceAll('{{firstName}}', firstName)
    .replaceAll('{{code}}', vars.code);
};

/**
 * Validate that a template references only known placeholders. Used at admin-
 * save time to refuse a typo like `{{name}}` instead of silently emitting it
 * literally to customers.
 */
export const validateEmailOtpTemplate = (
  template: string,
): { ok: true } | { ok: false; unknown: string[] } => {
  const allowed = new Set(['firstName', 'code']);
  const unknown: string[] = [];
  for (const match of template.matchAll(/\{\{(\w+)\}\}/g)) {
    const name = match[1]!;
    if (!allowed.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true };
};
