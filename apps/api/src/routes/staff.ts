import { hashPassword, STAFF_ROLES, type StaffRole } from '@memesh/auth';
import {
  countActiveAdmins,
  createStaff,
  db,
  deleteStaff,
  getStaffById,
  listStaff,
  updateStaff,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { phoneSchema } from '../lib/phone-schema.js';

// Roles that must have an email — they are the only roles that log into the
// web app, and email is the login username as of 2026-06-21. Cashier is
// allowed to have no email because their till-side attribution uses a PIN
// (see staff-pin routes), not a web login.
const ROLES_REQUIRING_EMAIL: ReadonlySet<StaffRole> = new Set(['admin', 'manager']);
const requiresEmail = (role: StaffRole): boolean => ROLES_REQUIRING_EMAIL.has(role);

// Lowercase + trim email at the boundary so the unique partial index on
// lower(email) and the case-insensitive login lookup see the same string.
const emailField = z.string().trim().toLowerCase().email().max(255);

const createSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  phone: phoneSchema,
  password: z.string().min(4).max(256),
  role: z.enum(STAFF_ROLES).optional(),
  email: emailField.optional(),
});

const patchSchema = z
  .object({
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    email: emailField.nullable().optional(),
    role: z.enum(STAFF_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });

/**
 * Pg unique-violation extraction. Used to map a 23505 on the email partial
 * unique index to a clean 409 email_taken response instead of a generic 500.
 */
const isUniqueViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  return String((err as { code?: unknown }).code) === '23505';
};

export const staffRoutes: FastifyPluginAsync = async (fastify) => {
  // Only an admin can add staff and set their initial password/PIN.
  // Admin and manager rows must carry an email — that's the login username
  // as of 2026-06-21. Cashier may still be created without an email because
  // they may only need till-side PIN attribution.
  fastify.post('/staff', { preHandler: requireRoleHook('admin') }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const role: StaffRole = parsed.data.role ?? 'cashier';
    if (requiresEmail(role) && !parsed.data.email) {
      request.log.info({ role }, '[staff create] rejected — email required for role');
      return reply.code(400).send({ error: 'email_required_for_role', role });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const member = await createStaff(db, {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        phone: parsed.data.phone,
        passwordHash,
        role,
        ...(parsed.data.email !== undefined && { email: parsed.data.email }),
      });
      request.log.info(
        { id: member.id, role: member.role, hasEmail: !!member.email },
        '[staff create] created',
      );
      return reply.code(201).send({ staff: member });
    } catch (err) {
      // 23505 fires on staff_phone_unique OR staff_email_lower_unique. The
      // constraint name is on the err; we keep the distinction so the admin
      // UI can tell the operator which field collided.
      const constraint =
        err && typeof err === 'object' && 'constraint' in err
          ? String((err as { constraint?: unknown }).constraint)
          : '';
      if (isUniqueViolation(err) && constraint === 'staff_email_lower_unique') {
        request.log.info({ constraint }, '[staff create] email_taken');
        return reply.code(409).send({ error: 'email_taken' });
      }
      if (isUniqueViolation(err)) {
        request.log.info({ constraint }, '[staff create] phone_taken');
        return reply.code(409).send({ error: 'phone_taken' });
      }
      request.log.warn({ err }, '[staff create] failed');
      return reply.code(409).send({ error: 'phone_taken' });
    }
  });

  // Admin and managers can see the team (never the password hashes).
  fastify.get('/staff', { preHandler: requireRoleHook('admin', 'manager') }, async () => {
    const members = await listStaff(db);
    return { staff: members };
  });

  // Edit a staff member (admin only). Phone stays read-only (it's the login
  // identity and changing it would invalidate the user's existing sessions).
  // Password updates need their own dedicated flow — not exposed here.
  // Self-deactivate guard: refuse to flip isActive=false on the caller's own id.
  fastify.patch('/staff/:id', { preHandler: requireRoleHook('admin') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    if (parsed.data.isActive === false && request.user?.id === id) {
      return reply.code(409).send({ error: 'cannot_deactivate_self' });
    }

    // Email-required-for-role guard. We have to consider three cases:
    //   1. Patch sets email=null on a row whose role requires email.
    //   2. Patch elevates role to admin/manager on a row that has no email
    //      (and patch doesn't supply one).
    //   3. Patch elevates role AND sets email=null in the same body.
    // Without this guard a future admin login would silently lose access
    // because the email lookup would never match.
    if (parsed.data.role !== undefined || parsed.data.email !== undefined) {
      const current = await getStaffById(db, id);
      if (!current) return reply.code(404).send({ error: 'not_found' });
      const nextRole: StaffRole = parsed.data.role ?? (current.role as StaffRole);
      const nextEmail =
        parsed.data.email !== undefined ? parsed.data.email : current.email;
      if (requiresEmail(nextRole) && (nextEmail === null || nextEmail === '')) {
        request.log.info(
          { id, nextRole },
          '[staff update] rejected — email required for role',
        );
        return reply
          .code(409)
          .send({ error: 'email_required_for_role', role: nextRole });
      }
    }

    try {
      const updated = await updateStaff(db, id, parsed.data);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      request.log.info({ id: updated.id, fields: Object.keys(parsed.data) }, '[staff update] updated');
      return { staff: updated };
    } catch (err) {
      const constraint =
        err && typeof err === 'object' && 'constraint' in err
          ? String((err as { constraint?: unknown }).constraint)
          : '';
      if (isUniqueViolation(err) && constraint === 'staff_email_lower_unique') {
        request.log.info({ id, constraint }, '[staff update] email_taken');
        return reply.code(409).send({ error: 'email_taken' });
      }
      request.log.warn({ err }, '[staff update] failed');
      return reply.code(500).send({ error: 'update_failed' });
    }
  });

  // Hard-delete a staff member (admin only). Refuses self-delete and refuses
  // to remove the last active admin (would lock the org out of administration).
  // If the staff row is still referenced (registered customers, punches,
  // staff_actions), Postgres throws an FK violation and we return 409 with
  // a clear code — the operator should deactivate via PATCH instead.
  fastify.delete(
    '/staff/:id',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      if (request.user?.id === id) {
        return reply.code(409).send({ error: 'cannot_delete_self' });
      }
      // If this admin is the last active admin, refuse the delete. Best-effort
      // (small race against a concurrent delete; the FK guard below is the
      // real safety net for data loss, this is just clearer UX).
      const target = await listStaff(db);
      const targetRow = target.find((s) => s.id === id);
      if (!targetRow) return reply.code(404).send({ error: 'not_found' });
      if (targetRow.role === 'admin' && targetRow.isActive) {
        const activeAdmins = await countActiveAdmins(db);
        if (activeAdmins <= 1) {
          return reply.code(409).send({ error: 'cannot_delete_last_admin' });
        }
      }
      try {
        const deleted = await deleteStaff(db, id);
        if (!deleted) return reply.code(404).send({ error: 'not_found' });
        request.log.info({ id }, '[staff] deleted');
        return { ok: true };
      } catch (err) {
        // 23503 = foreign_key_violation. The staff row has dependents
        // (registered customers, punches, cancellations, staff_actions). Tell
        // the operator to deactivate instead of deleting.
        const code =
          err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
        if (code === '23503') {
          request.log.info({ id }, '[staff] delete blocked by FK; suggest deactivate');
          return reply.code(409).send({ error: 'has_dependents' });
        }
        request.log.warn({ err }, '[staff] delete failed');
        return reply.code(500).send({ error: 'delete_failed' });
      }
    },
  );
};
