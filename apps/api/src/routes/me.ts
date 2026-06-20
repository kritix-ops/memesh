import {
  type CustomerProfilePatch,
  db,
  getCustomerById,
  punchCards,
  updateCustomerProfile,
} from '@memesh/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCustomer } from '../lib/customer-guard.js';

const childSchema = z.object({
  name: z.string().min(1).max(80),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(500).optional(),
});

const patchSchema = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  email: z.string().email().max(255).optional(),
  preferredChannel: z.enum(['sms', 'whatsapp', 'email']).optional(),
  children: z.array(childSchema).max(20).optional(),
});

type CustomerRow = NonNullable<Awaited<ReturnType<typeof getCustomerById>>>;

// Customer-facing view: omits staff-only fields (internal notes, registered_by).
const profileView = (c: CustomerRow) => ({
  id: c.id,
  customerNumber: c.customerNumber,
  firstName: c.firstName,
  lastName: c.lastName,
  phone: c.phone,
  email: c.email,
  preferredChannel: c.preferredChannel,
  children: c.children,
});

export const meRoutes: FastifyPluginAsync = async (fastify) => {
  // The logged-in customer's active cards.
  fastify.get('/me/cards', { preHandler: requireCustomer }, async (request) => {
    const customerId = request.customer?.id;
    if (!customerId) return { cards: [] };
    const cards = await db
      .select()
      .from(punchCards)
      .where(and(eq(punchCards.customerId, customerId), eq(punchCards.isActive, true)))
      .orderBy(desc(punchCards.createdAt));
    return { cards };
  });

  fastify.get('/me', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const customer = await getCustomerById(db, customerId);
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    return { profile: profileView(customer) };
  });

  // Edit own details. Phone is intentionally not editable (it is the login id).
  fastify.patch('/me', { preHandler: requireCustomer }, async (request, reply) => {
    const customerId = request.customer?.id;
    if (!customerId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const patch: CustomerProfilePatch = {};
    if (parsed.data.firstName !== undefined) patch.firstName = parsed.data.firstName;
    if (parsed.data.lastName !== undefined) patch.lastName = parsed.data.lastName;
    if (parsed.data.email !== undefined) patch.email = parsed.data.email;
    if (parsed.data.preferredChannel !== undefined) {
      patch.preferredChannel = parsed.data.preferredChannel;
    }
    if (parsed.data.children !== undefined) {
      patch.children = parsed.data.children.map((c) =>
        c.notes !== undefined
          ? { name: c.name, dob: c.dob, notes: c.notes }
          : { name: c.name, dob: c.dob },
      );
    }

    const updated = await updateCustomerProfile(db, customerId, patch);
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return { profile: profileView(updated) };
  });
};
