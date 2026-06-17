import { dashboardStats, db, dormantCustomers, listStaffActions } from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { requireRoleHook } from '../lib/auth-guards.js';

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
};
