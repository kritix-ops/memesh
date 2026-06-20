import { verifyPassword } from '@memesh/auth';
import {
  db,
  deleteStaffPin,
  generateRandomPin,
  getCardSettings,
  getStaffById,
  getStaffPin,
  isStaffPinLocked,
  staff,
  unlockStaffPin,
} from '@memesh/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuthHook, requireRoleHook } from '../lib/auth-guards.js';
import { setStaffPinFromRaw } from '../lib/staff-pin-repo.js';

const MANAGER_OR_ADMIN = ['manager', 'admin'] as const;

// Set + generate share the same digits-only shape; the per-request length
// guard lives below (it's settings-driven).
const setPinBodySchema = z.object({
  pin: z.string().regex(/^\d+$/, 'pin_must_be_digits'),
});

// Self-service PIN change: takes the cashier's current password as a
// fresh-auth gate. The shape mirrors the refund-flow's "admin password
// confirmation" pattern (see refund route in cards.ts).
const selfSetPinBodySchema = z.object({
  pin: z.string().regex(/^\d+$/, 'pin_must_be_digits'),
  password: z.string().min(1).max(256),
});

interface PinStatusBody {
  exists: boolean;
  locked: boolean;
  lockedUntil: string | null;
  failedCount: number;
}

async function readPinStatus(staffId: string): Promise<PinStatusBody> {
  const row = await getStaffPin(db, staffId);
  if (!row) return { exists: false, locked: false, lockedUntil: null, failedCount: 0 };
  const locked = isStaffPinLocked(row);
  return {
    exists: true,
    locked,
    lockedUntil: locked ? row.lockedUntil!.toISOString() : null,
    failedCount: row.failedCount,
  };
}

export const staffPinRoutes: FastifyPluginAsync = async (fastify) => {
  // Read PIN status for a cashier (admin/manager). Used by the admin Staff
  // page to render the "PIN set / not set / locked" badge per row.
  fastify.get(
    '/staff/:id/pin',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const target = await getStaffById(db, id);
      if (!target) return reply.code(404).send({ error: 'not_found' });
      return readPinStatus(id);
    },
  );

  // Admin/manager sets a specific PIN for a cashier. Used when the cashier
  // chose a code on paper and the manager types it in at the till. Validates
  // PIN length against the live setting so a 3-digit PIN can't be set when
  // policy moves to 4-digit.
  fastify.put(
    '/staff/:id/pin',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const parsed = setPinBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const target = await getStaffById(db, id);
      if (!target) return reply.code(404).send({ error: 'not_found' });
      const settings = await getCardSettings(db);
      if (parsed.data.pin.length !== settings.pinLength) {
        return reply.code(400).send({
          error: 'pin_wrong_length',
          expected: settings.pinLength,
        });
      }
      await setStaffPinFromRaw(id, parsed.data.pin);
      request.log.info(
        { staffId: id, byStaffId: request.user?.id },
        '[auth pin set] by manager/admin',
      );
      return readPinStatus(id);
    },
  );

  // Admin/manager generates a random PIN for a cashier and gets it back ONCE
  // so they can read it to the cashier. The server never echoes it again —
  // the hashed copy in staff_pins is the only persistent record.
  fastify.post(
    '/staff/:id/pin/generate',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const target = await getStaffById(db, id);
      if (!target) return reply.code(404).send({ error: 'not_found' });
      const settings = await getCardSettings(db);
      const pin = generateRandomPin(settings.pinLength);
      await setStaffPinFromRaw(id, pin);
      request.log.info(
        { staffId: id, byStaffId: request.user?.id, length: pin.length },
        '[auth pin generate] by manager/admin',
      );
      const status = await readPinStatus(id);
      // Caller MUST surface this to the manager once — we never return it again.
      return { ...status, pin };
    },
  );

  // Admin/manager removes a cashier's PIN. After this the cashier cannot
  // sell anything until a new PIN is set. Idempotent: 200 even when no row
  // existed (lets the UI button stay enabled without a pre-check).
  fastify.delete(
    '/staff/:id/pin',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const target = await getStaffById(db, id);
      if (!target) return reply.code(404).send({ error: 'not_found' });
      const removed = await deleteStaffPin(db, id);
      request.log.info(
        { staffId: id, byStaffId: request.user?.id, removed },
        '[auth pin delete] by manager/admin',
      );
      return { ok: true, removed };
    },
  );

  // Admin/manager clears the lockout state. Used when a cashier got locked
  // out at the till and needs to keep working.
  fastify.post(
    '/staff/:id/pin/unlock',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const target = await getStaffById(db, id);
      if (!target) return reply.code(404).send({ error: 'not_found' });
      const ok = await unlockStaffPin(db, id);
      if (!ok) {
        // No PIN row to unlock. Surface a clean 409 so the UI can refresh.
        return reply.code(409).send({ error: 'no_pin' });
      }
      request.log.info(
        { staffId: id, byStaffId: request.user?.id },
        '[auth pin unlock] by manager/admin',
      );
      return readPinStatus(id);
    },
  );

  // Self-service PIN read for the cashier's own settings page.
  fastify.get('/me/pin', { preHandler: requireAuthHook }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthorized' });
    return readPinStatus(request.user.id);
  });

  // Self-service PIN set. Requires the cashier's current password as a
  // fresh-auth gate — a stolen-and-logged-in session cannot silently rotate
  // the PIN. Same pattern as the refund flow's admin-password check.
  fastify.put('/me/pin', { preHandler: requireAuthHook }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = selfSetPinBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    // Re-verify the caller's password directly to avoid trusting only the
    // session cookie for the PIN-rotation action.
    const rows = await db
      .select({ passwordHash: staff.passwordHash })
      .from(staff)
      .where(eq(staff.id, request.user.id))
      .limit(1);
    const row = rows[0];
    if (!row?.passwordHash) {
      return reply.code(409).send({ error: 'no_password_on_account' });
    }
    const ok = await verifyPassword(parsed.data.password, row.passwordHash);
    if (!ok) {
      request.log.info({ staffId: request.user.id }, '[auth pin self-set] password mismatch');
      return reply.code(401).send({ error: 'invalid_password' });
    }
    const settings = await getCardSettings(db);
    if (parsed.data.pin.length !== settings.pinLength) {
      return reply.code(400).send({
        error: 'pin_wrong_length',
        expected: settings.pinLength,
      });
    }
    await setStaffPinFromRaw(request.user.id, parsed.data.pin);
    request.log.info({ staffId: request.user.id }, '[auth pin self-set] success');
    return readPinStatus(request.user.id);
  });
};
