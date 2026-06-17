import { createHash } from 'node:crypto';
import { db, punchCard, punchCards, scanAttempts } from '@memesh/db';
import { isVerifyFailure, verifyToken } from '@memesh/qr-engine';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';

const STAFF = ['cashier', 'manager', 'admin'] as const;

const bodySchema = z
  .object({
    token: z.string().min(1).max(2048).optional(),
    serial: z.string().min(1).max(32).optional(),
    companions: z.number().int().min(1).max(4).optional(),
    idempotencyKey: z.string().min(1).max(64).optional(),
    terminalId: z.string().min(1).max(64).optional(),
  })
  .refine((b) => Boolean(b.token) || Boolean(b.serial), {
    message: 'token or serial is required',
  });

// Failures map to HTTP: 404 for unknown, 409 for a card that exists but cannot be punched.
const reasonStatus: Record<string, number> = {
  not_found: 404,
  inactive: 409,
  expired: 409,
  exhausted: 409,
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
      const { token, serial, companions, idempotencyKey, terminalId } = parsed.data;

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
        ...(companions !== undefined && { companionCount: companions }),
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        audit: {
          ...(qrTokenHash !== undefined && { qrTokenHash }),
          ipAddress: request.ip,
          ...(terminalId !== undefined && { terminalId }),
        },
      });

      if (!result.ok) {
        return reply
          .code(reasonStatus[result.reason] ?? 409)
          .send({ ok: false, error: result.reason });
      }
      return {
        ok: true,
        replay: result.replay,
        remaining: result.remaining,
        usedEntries: result.usedEntries,
        totalEntries: result.totalEntries,
      };
    },
  );
};
