import { hashPassword, STAFF_ROLES } from '@memesh/auth';
import { createStaff, db, listStaff, updateStaff } from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { phoneSchema } from '../lib/phone-schema.js';

const createSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  phone: phoneSchema,
  password: z.string().min(4).max(256),
  role: z.enum(STAFF_ROLES).optional(),
  email: z.string().email().max(255).optional(),
});

const patchSchema = z
  .object({
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    email: z.string().email().max(255).nullable().optional(),
    role: z.enum(STAFF_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });

export const staffRoutes: FastifyPluginAsync = async (fastify) => {
  // Only an admin can add staff and set their initial password/PIN.
  fastify.post('/staff', { preHandler: requireRoleHook('admin') }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const member = await createStaff(db, {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        phone: parsed.data.phone,
        passwordHash,
        ...(parsed.data.role !== undefined && { role: parsed.data.role }),
        ...(parsed.data.email !== undefined && { email: parsed.data.email }),
      });
      request.log.info({ id: member.id, role: member.role }, '[staff] created');
      return reply.code(201).send({ staff: member });
    } catch (err) {
      request.log.warn({ err }, '[staff] create failed');
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
    try {
      const updated = await updateStaff(db, id, parsed.data);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      request.log.info({ id: updated.id, fields: Object.keys(parsed.data) }, '[staff] updated');
      return { staff: updated };
    } catch (err) {
      // Email is uniquely not nullable in the schema but isn't unique; the
      // only realistic constraint failure is a future unique-email index.
      request.log.warn({ err }, '[staff] update failed');
      return reply.code(500).send({ error: 'update_failed' });
    }
  });
};
