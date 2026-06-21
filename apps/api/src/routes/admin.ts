import {
  dashboardStats,
  db,
  dormantCustomers,
  listStaffActions,
  logStaffAction,
  reMintAllPunchCardTokens,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/admin/dashboard',
    { preHandler: requireRoleHook('admin', 'manager') },
    async () => ({ stats: await dashboardStats(db) }),
  );

  // Re-engagement list: customers who hold a card but have not visited in 30 days.
  fastify.get(
    '/admin/reports/dormant',
    { preHandler: requireRoleHook('admin', 'manager') },
    async () => ({ customers: await dormantCustomers(db) }),
  );

  // Staff action log (who did what, when).
  fastify.get('/admin/actions', { preHandler: requireRoleHook('admin', 'manager') }, async () => ({
    actions: await listStaffActions(db),
  }));

  // Bulk re-sign every card's qr_token with the current envKeyResolver. Used
  // when the signing secret was rotated (or cards were minted under a foreign
  // env) and existing tokens fail HMAC verify even though the card rows
  // themselves are valid. Idempotent — a no-op on the second call. The card
  // identity (id, customer, serial, createdAt) is preserved; only the
  // signature and key_id are refreshed. Admin-only and rate-limited because
  // this iterates every active card row.
  fastify.post(
    '/admin/cards/re-mint-tokens',
    {
      preHandler: requireRoleHook('admin'),
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    },
    async (request) => {
      const result = await reMintAllPunchCardTokens(db, envKeyResolver);
      request.log.info({ ...result }, '[admin re-mint] bulk re-mint complete');
      await logStaffAction(db, {
        ...(request.user && { staffId: request.user.id }),
        action: 'other',
        summary: `Re-minted qr_token on ${result.updated} of ${result.scanned} cards`,
      });
      return result;
    },
  );
};
