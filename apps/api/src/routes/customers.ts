import { createCustomer, customerDetail, customers, db } from '@memesh/db';
import { ilike, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';
import { phoneSchema } from '../lib/phone-schema.js';
import { getWpClient } from '../lib/wp-client.js';
import { syncCustomerToWp } from '../lib/wp-sync.js';

const STAFF = ['cashier', 'manager', 'admin'] as const;

// null when WP sync is not configured.
const wpClient = getWpClient();

const childSchema = z.object({
  name: z.string().min(1).max(80),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(500).optional(),
});

const createBodySchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  phone: phoneSchema,
  email: z.string().email().max(255).optional(),
  preferredChannel: z.enum(['sms', 'whatsapp', 'email']).optional(),
  // Optional marketing fields (Yanai feedback item 2). All independently
  // optional; missing means "no preference / not collected".
  source: z.enum(['referral', 'social', 'walk_by', 'website', 'other']).optional(),
  children: z.array(childSchema).max(20).optional(),
  marketingConsent: z.boolean().optional(),
});

export const customersRoutes: FastifyPluginAsync = async (fastify) => {
  // Register a new customer (allocates the L-NNNN customer number).
  fastify.post('/customers', { preHandler: requireRoleHook(...STAFF) }, async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      const customer = await createCustomer(db, {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        phone: parsed.data.phone,
        ...(parsed.data.email !== undefined && { email: parsed.data.email }),
        ...(parsed.data.preferredChannel !== undefined && {
          preferredChannel: parsed.data.preferredChannel,
        }),
        ...(parsed.data.source !== undefined && { source: parsed.data.source }),
        ...(parsed.data.children !== undefined && {
          children: parsed.data.children.map((c) =>
            c.notes !== undefined
              ? { name: c.name, dob: c.dob, notes: c.notes }
              : { name: c.name, dob: c.dob },
          ),
        }),
        ...(parsed.data.marketingConsent !== undefined && {
          marketingConsent: parsed.data.marketingConsent,
        }),
        ...(request.user && { registeredBy: request.user.id }),
      });
      request.log.info({ id: customer.id, number: customer.customerNumber }, '[customers] created');
      // One-way WP sync, never in the request path: fire-and-forget, errors logged.
      if (wpClient) {
        void syncCustomerToWp(wpClient, db, customer).catch((err) =>
          request.log.warn({ err, id: customer.id }, '[wp sync] failed'),
        );
      }
      return reply.code(201).send({ customer });
    } catch (err) {
      // The only collidable unique field on a fresh register is the phone.
      request.log.warn({ err }, '[customers] create failed');
      return reply.code(409).send({ error: 'phone_taken' });
    }
  });

  // Full customer detail (cards + recent entries) for the staff card screen.
  fastify.get(
    '/customers/:id',
    { preHandler: requireRoleHook(...STAFF) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const detail = await customerDetail(db, id);
      if (!detail) return reply.code(404).send({ error: 'not_found' });
      return detail;
    },
  );

  // Search by name, phone, or customer number for the staff lookup screen.
  fastify.get('/customers', { preHandler: requireRoleHook(...STAFF) }, async (request, reply) => {
    const q = (request.query as { q?: string }).q?.trim();
    if (!q) return reply.code(400).send({ error: 'missing_query' });
    const pattern = `%${q}%`;
    const results = await db
      .select()
      .from(customers)
      .where(
        or(
          ilike(customers.firstName, pattern),
          ilike(customers.lastName, pattern),
          ilike(customers.phone, pattern),
          ilike(customers.customerNumber, pattern),
        ),
      )
      .limit(20);
    return { results };
  });
};
