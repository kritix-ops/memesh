import { createHash } from 'node:crypto';
import {
  customers,
  db,
  getCardSettings,
  getRoundSettings,
  listUpcomingReservationsForCustomer,
  punchCard,
  punchCards,
  scanAttempts,
  scanCardLookup,
} from '@memesh/db';
import { isVerifyFailure, verifyToken } from '@memesh/qr-engine';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { sendMarketingSms } from '../lib/sms.js';
import { envKeyResolver } from '../qr.js';

const STAFF = ['cashier', 'manager', 'admin'] as const;

const bodySchema = z
  .object({
    token: z.string().min(1).max(2048).optional(),
    serial: z.string().min(1).max(32).optional(),
    /** How many entries this scan should consume. 1..100 (server caps further by
     *  the card's remaining entries). Defaults to 1 when omitted. */
    entries: z.number().int().min(1).max(100).optional(),
    idempotencyKey: z.string().min(1).max(64).optional(),
    terminalId: z.string().min(1).max(64).optional(),
  })
  .refine((b) => Boolean(b.token) || Boolean(b.serial), {
    message: 'token or serial is required',
  });

// Same input as /punch (token or serial) but without entries / idempotency —
// the preview is a pure read.
const lookupBodySchema = z
  .object({
    token: z.string().min(1).max(2048).optional(),
    serial: z.string().min(1).max(32).optional(),
    terminalId: z.string().min(1).max(64).optional(),
  })
  .refine((b) => Boolean(b.token) || Boolean(b.serial), {
    message: 'token or serial is required',
  });

// Failures map to HTTP: 404 for unknown, 409 for a card that exists but cannot
// be punched, 400 for a malformed request (entries < 1 or > remaining), 429 for
// a settings-driven rate limit (same-day lockout).
const reasonStatus: Record<string, number> = {
  not_found: 404,
  inactive: 409,
  expired: 409,
  exhausted: 409,
  locked_out: 429,
  entries_out_of_range: 400,
};

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const punchRoutes: FastifyPluginAsync = async (fastify) => {
  // Punch one entry. QR token is primary; serial is the human fallback.
  // Tighter rate limit than the global default: a real till does not scan 30x/min.
  fastify.post(
    '/punch',
    {
      preHandler: requireRoleHook(...STAFF),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const { token, serial, entries, idempotencyKey, terminalId } = parsed.data;

      let punchCardId: string | undefined;
      let method: 'qr_scan' | 'serial' = 'serial';
      let qrTokenHash: string | undefined;

      if (token) {
        method = 'qr_scan';
        qrTokenHash = hashToken(token);
        const verified = verifyToken(token, envKeyResolver);
        if (isVerifyFailure(verified)) {
          await db.insert(scanAttempts).values({
            qrTokenHash,
            result: 'invalid_signature',
            ipAddress: request.ip,
            terminalId: terminalId ?? null,
          });
          request.log.info({ error: verified.error }, '[punch] invalid token');
          return reply.code(401).send({ ok: false, error: 'invalid_signature' });
        }
        punchCardId = verified.payload.punchCardId;
      } else if (serial) {
        const rows = await db
          .select({ id: punchCards.id })
          .from(punchCards)
          .where(eq(punchCards.serialNumber, serial))
          .limit(1);
        const row = rows[0];
        if (!row) {
          await db.insert(scanAttempts).values({
            result: 'not_found',
            ipAddress: request.ip,
            terminalId: terminalId ?? null,
          });
          return reply.code(404).send({ ok: false, error: 'not_found' });
        }
        punchCardId = row.id;
      }

      if (!punchCardId) return reply.code(400).send({ error: 'invalid_body' });

      const result = await punchCard(db, {
        punchCardId,
        method,
        ...(request.user && { punchedBy: request.user.id }),
        ...(entries !== undefined && { entries }),
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        audit: {
          ...(qrTokenHash !== undefined && { qrTokenHash }),
          ipAddress: request.ip,
          ...(terminalId !== undefined && { terminalId }),
        },
      });

      if (!result.ok) {
        const body: Record<string, unknown> = { ok: false, error: result.reason };
        if (result.reason === 'locked_out' && result.retryAfterMinutes !== undefined) {
          body.retryAfterMinutes = result.retryAfterMinutes;
        }
        if (result.reason === 'entries_out_of_range' && result.allowedRange) {
          body.allowedRange = result.allowedRange;
        }
        return reply.code(reasonStatus[result.reason] ?? 409).send(body);
      }

      // Fire-and-log marketing SMS when remaining ≤ threshold. The wrapper
      // enforces the setting, consent, and quiet hours. Skips for replays so
      // a network retry doesn't trigger a duplicate SMS.
      if (!result.replay) {
        void (async () => {
          try {
            const settings = await getCardSettings(db);
            if (
              settings.smsLowEntriesThreshold > 0 &&
              result.remaining <= settings.smsLowEntriesThreshold &&
              result.remaining > 0
            ) {
              const custRows = await db
                .select({
                  phone: customers.phone,
                  marketingConsentAt: customers.marketingConsentAt,
                  firstName: customers.firstName,
                })
                .from(customers)
                .leftJoin(punchCards, eq(punchCards.customerId, customers.id))
                .where(eq(punchCards.id, punchCardId!))
                .limit(1);
              const cust = custRows[0];
              if (cust) {
                await sendMarketingSms({
                  to: cust.phone,
                  body: `${cust.firstName} שלום, נותרו ${result.remaining} כניסות בכרטיסייה שלך ב-Memesh. נשמח לראות אותך שוב!`,
                  marketingConsentAt: cust.marketingConsentAt,
                  kind: 'low_entries',
                  log: request.log,
                  settings,
                });
              }
            }
          } catch (err) {
            request.log.warn({ err }, '[punch] low-entries SMS failed silently');
          }
        })();
      }

      return {
        ok: true,
        replay: result.replay,
        entriesConsumed: result.entriesConsumed,
        remaining: result.remaining,
        usedEntries: result.usedEntries,
        totalEntries: result.totalEntries,
        grace: result.grace,
      };
    },
  );

  // Preview: same verify-and-resolve as /punch, but returns the customer +
  // card + entry history without consuming an entry. Powers the POS scan
  // preview modal so the cashier can confirm "is this the right person?"
  // before punching. Failed lookups still audit to scan_attempts so brute
  // force against serials is visible.
  fastify.post(
    '/scan/lookup',
    {
      preHandler: requireRoleHook(...STAFF),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = lookupBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const { token, serial, terminalId } = parsed.data;

      let punchCardId: string | undefined;

      if (token) {
        const qrTokenHash = hashToken(token);
        const verified = verifyToken(token, envKeyResolver);
        if (isVerifyFailure(verified)) {
          await db.insert(scanAttempts).values({
            qrTokenHash,
            result: 'invalid_signature',
            ipAddress: request.ip,
            terminalId: terminalId ?? null,
          });
          request.log.info({ error: verified.error }, '[scan lookup] invalid token');
          return reply.code(401).send({ error: 'invalid_signature' });
        }
        punchCardId = verified.payload.punchCardId;
      } else if (serial) {
        const rows = await db
          .select({ id: punchCards.id })
          .from(punchCards)
          .where(eq(punchCards.serialNumber, serial))
          .limit(1);
        const row = rows[0];
        if (!row) {
          await db.insert(scanAttempts).values({
            result: 'not_found',
            ipAddress: request.ip,
            terminalId: terminalId ?? null,
          });
          return reply.code(404).send({ error: 'not_found' });
        }
        punchCardId = row.id;
      }

      if (!punchCardId) return reply.code(400).send({ error: 'invalid_body' });

      const preview = await scanCardLookup(db, punchCardId);
      if (!preview) return reply.code(404).send({ error: 'not_found' });

      // Door warning (Yanay 2026-07-07): a punch-card round reservation already
      // spent its entry at booking time, so surface the customer's upcoming
      // reserved rounds here — the cashier is reminded not to let them burn the
      // card down before a reserved date, and doesn't think an entry vanished.
      // Gated by the venue setting; empty (no warning) when off.
      const roundSettings = await getRoundSettings(db);
      const upcomingReservations =
        roundSettings.warnUpcomingReservationAtDoor && preview.customer.id
          ? await listUpcomingReservationsForCustomer(db, preview.customer.id)
          : [];

      request.log.info(
        {
          mode: token ? 'token' : 'serial',
          status: preview.status,
          upcomingReservations: upcomingReservations.length,
        },
        '[scan lookup]',
      );
      return { ...preview, upcomingReservations };
    },
  );
};
