import {
  createCustomer,
  customerDetail,
  customers,
  db,
  deleteCustomer,
  getCardSettings,
} from '@memesh/db';
import { desc, ilike, or } from 'drizzle-orm';
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

    // Settings-driven required fields: email and/or ≥1 child can be made
    // required for new customers. Returns granular error codes so the
    // frontend can highlight the right inputs.
    const settings = await getCardSettings(db);
    if (settings.requireEmailOnNewCustomer && !parsed.data.email) {
      return reply.code(400).send({ error: 'email_required' });
    }
    if (
      settings.requireChildOnNewCustomer &&
      (!parsed.data.children || parsed.data.children.length === 0)
    ) {
      return reply.code(400).send({ error: 'child_required' });
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

  // Hard-delete a customer (admin/manager only). Cashiers cannot delete
  // — they can only register new customers and punch cards.
  //
  // Cancellation-gated cascade (Yanay bug report 2026-06-22): the repository
  // function only blocks when at least one card is still ACTIVE (cancelled_at
  // IS NULL). Cancelled cards no longer block — they get hard-deleted along
  // with their punch entries inside the same transaction so the user's
  // mental model ("I cancelled all my cards, now I can delete the customer")
  // matches reality. Active cards still return 409 with `has_active_cards`
  // so the operator gets a precise "cancel them first" message.
  fastify.delete(
    '/customers/:id',
    { preHandler: requireRoleHook('admin', 'manager') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      try {
        const result = await deleteCustomer(db, id);
        if (!result.ok) {
          if (result.reason === 'not_found') {
            return reply.code(404).send({ error: 'not_found' });
          }
          if (result.reason === 'has_active_cards') {
            request.log.info(
              { id, activeCount: result.activeCount },
              '[customers] delete blocked: active cards',
            );
            return reply.code(409).send({
              error: 'has_active_cards',
              activeCount: result.activeCount,
            });
          }
        }
        request.log.info({ id }, '[customers] deleted');
        return { ok: true };
      } catch (err) {
        request.log.warn({ err, id }, '[customers] delete failed');
        return reply.code(500).send({ error: 'delete_failed' });
      }
    },
  );

  // Search by name, phone, or customer number for the staff lookup screen.
  // When no `q` is provided, return the most recent N customers — this is what
  // the admin Customers tab uses as its default list (so an operator who has
  // just added a customer immediately sees them without having to type a
  // search). The cap stays small (50) so the response is fast and the UI
  // doesn't try to render thousands of rows.
  fastify.get('/customers', { preHandler: requireRoleHook(...STAFF) }, async (request, _reply) => {
    const q = (request.query as { q?: string }).q?.trim();
    if (!q) {
      const results = await db
        .select()
        .from(customers)
        .orderBy(desc(customers.createdAt))
        .limit(50);
      return { results };
    }
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
      .orderBy(desc(customers.createdAt))
      .limit(20);
    return { results };
  });
};
