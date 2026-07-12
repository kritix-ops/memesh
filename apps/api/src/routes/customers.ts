import {
  createCustomer,
  customerDetail,
  db,
  deleteCustomer,
  getCardSettings,
  listCustomers,
  logStaffAction,
  updateCustomerPhone,
} from '@memesh/db';
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

// GET /customers query params. All optional so a bare request keeps its
// legacy meaning; hasActiveCard travels as a string because query strings
// have no booleans.
const listQuerySchema = z.object({
  q: z.string().max(120).optional(),
  sort: z.enum(['name', 'newest', 'oldest', 'lastPurchase']).optional(),
  status: z.enum(['active', 'frozen', 'vip']).optional(),
  hasActiveCard: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Staff-only phone change. Reuses the shared normalizer so the stored value
// matches every other write (and future WooCommerce phone matching).
const phonePatchSchema = z.object({ phone: phoneSchema });

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

  // Change a customer's phone number (admin/manager only — same gate as delete).
  // Phone is the customer's login identity and was intentionally left out of the
  // self-service /me patch and the create-only write surface; this is the
  // staff override for the "customer changed her number" case. Everything that
  // references a customer keys off customer_id, so cards/bookings/sessions are
  // untouched; the only hazard is a collision with another customer, returned
  // as 409 phone_taken.
  //
  // Known limitation (not fixed here): the linked WordPress user keeps its old
  // phone-as-username. Customer login is phone+OTP against Memesh, not WP, so
  // this is cosmetic; renaming a WP user is a separate, riskier operation.
  fastify.patch(
    '/customers/:id/phone',
    { preHandler: requireRoleHook('admin', 'manager') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const parsed = phonePatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const result = await updateCustomerPhone(db, id, parsed.data.phone);
      if (!result.ok) {
        if (result.reason === 'not_found') {
          return reply.code(404).send({ error: 'not_found' });
        }
        request.log.info({ id, phone: parsed.data.phone }, '[customers] phone change: taken');
        return reply.code(409).send({ error: 'phone_taken' });
      }

      if (result.changed) {
        request.log.info(
          { id, from: result.previousPhone, to: result.customer.phone },
          '[customers] phone changed',
        );
        await logStaffAction(db, {
          ...(request.user && { staffId: request.user.id }),
          action: 'other',
          summary: `Changed phone for ${result.customer.customerNumber} to ${result.customer.phone}`,
        });
      }
      return { customer: result.customer };
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

  // Browse / search the customer directory for the staff lookup screen and
  // the admin Customers tab. Free text (q), sort, status / active-card
  // filters, and limit/offset pagination all compose in SQL (see
  // listCustomers in @memesh/db). Defaults preserve the legacy behavior a
  // bare request had: newest-first, 50 rows without q, 20 with. The response
  // adds `total` (count across all pages) and per-row `lastPurchaseAt` —
  // both additive, so older consumers that only read `results` are
  // unaffected.
  fastify.get('/customers', { preHandler: requireRoleHook(...STAFF) }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { sort, status, hasActiveCard, limit, offset } = parsed.data;
    const q = parsed.data.q?.trim();
    const result = await listCustomers(db, {
      ...(q && { q }),
      sort: sort ?? 'newest',
      ...(status && { status }),
      ...(hasActiveCard !== undefined && { hasActiveCard: hasActiveCard === 'true' }),
      limit: limit ?? (q ? 20 : 50),
      offset: offset ?? 0,
    });
    request.log.info(
      {
        q: q ?? null,
        sort: sort ?? 'newest',
        status: status ?? null,
        hasActiveCard: hasActiveCard ?? null,
        offset: offset ?? 0,
        count: result.results.length,
        total: result.total,
      },
      '[customers] list',
    );
    return result;
  });
};
