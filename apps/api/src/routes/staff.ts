import { hashPassword, STAFF_ROLES } from '@memesh/auth';
import { createStaff, db, listStaff } from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';

const createSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  phone: z.string().min(3).max(32),
  password: z.string().min(4).max(256),
  role: z.enum(STAFF_ROLES).optional(),
  email: z.string().email().max(255).optional(),
});

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
};
