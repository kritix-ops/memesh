import { db, punchCards } from '@memesh/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { requireCustomer } from '../lib/customer-guard.js';

export const meRoutes: FastifyPluginAsync = async (fastify) => {
  // The logged-in customer's active cards (remaining entries shown by the client).
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
};
