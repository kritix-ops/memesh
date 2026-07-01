import {
  cancellationsReport,
  cardsReport,
  customersReport,
  db,
  entriesReport,
  revenueReport,
  type CancellationsReportFilters,
  type CardsReportFilters,
  type CustomersReportFilters,
  type EntriesReportFilters,
  type RevenueReportFilters,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';

const MANAGER_OR_ADMIN = ['manager', 'admin'] as const;

const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

const customersQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  registeredFrom: isoDate.optional(),
  registeredTo: isoDate.optional(),
  source: z.enum(['referral', 'social', 'walk_by', 'website', 'other']).optional(),
  marketingConsent: z.enum(['true', 'false']).optional(),
  hasActiveCard: z.enum(['true', 'false']).optional(),
  dormantSinceDays: z.coerce.number().int().min(1).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  sort: z.enum(['createdAt', 'lastVisit', 'customerNumber']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const cardsReportQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'expired', 'cancelled']).optional(),
  source: z.enum(['pos', 'online', 'manual']).optional(),
  soldFrom: isoDate.optional(),
  soldTo: isoDate.optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
  usageMinPct: z.coerce.number().int().min(0).max(100).optional(),
  usageMaxPct: z.coerce.number().int().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  sort: z.enum(['createdAt', 'expiresAt', 'usedEntries', 'serialNumber']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const entriesQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  customerId: z.string().uuid().optional(),
  cardSerial: z.string().trim().min(1).max(64).optional(),
  method: z.enum(['qr_scan', 'serial', 'phone', 'manual', 'online']).optional(),
  refunded: z.enum(['true', 'false']).optional(),
  punchedBy: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const revenueQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  groupBy: z.enum(['day', 'week', 'month']).optional(),
});

const cancellationsQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  kind: z.enum(['card', 'entry']).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const toDate = (s: string | undefined): Date | undefined =>
  s === undefined ? undefined : new Date(s);

const toBool = (s: 'true' | 'false' | undefined): boolean | undefined =>
  s === undefined ? undefined : s === 'true';

export const reportsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/admin/reports/customers',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const parsed = customersQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      const f: CustomersReportFilters = {};
      if (parsed.data.q !== undefined) f.q = parsed.data.q;
      const rf = toDate(parsed.data.registeredFrom);
      const rt = toDate(parsed.data.registeredTo);
      if (rf) f.registeredFrom = rf;
      if (rt) f.registeredTo = rt;
      if (parsed.data.source) f.source = parsed.data.source;
      const mc = toBool(parsed.data.marketingConsent);
      if (mc !== undefined) f.marketingConsent = mc;
      const hac = toBool(parsed.data.hasActiveCard);
      if (hac !== undefined) f.hasActiveCard = hac;
      if (parsed.data.dormantSinceDays !== undefined)
        f.dormantSinceDays = parsed.data.dormantSinceDays;
      if (parsed.data.limit !== undefined) f.limit = parsed.data.limit;
      if (parsed.data.sort) f.sort = parsed.data.sort;
      if (parsed.data.sortDir) f.sortDir = parsed.data.sortDir;

      const rows = await customersReport(db, f);
      request.log.info({ count: rows.length }, '[reports.customers]');
      return { rows };
    },
  );

  fastify.get(
    '/admin/reports/cards',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const parsed = cardsReportQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      const f: CardsReportFilters = {};
      if (parsed.data.q !== undefined) f.q = parsed.data.q;
      if (parsed.data.status) f.status = parsed.data.status;
      if (parsed.data.source) f.source = parsed.data.source;
      const sf = toDate(parsed.data.soldFrom);
      const st = toDate(parsed.data.soldTo);
      if (sf) f.soldFrom = sf;
      if (st) f.soldTo = st;
      if (parsed.data.expiringWithinDays !== undefined)
        f.expiringWithinDays = parsed.data.expiringWithinDays;
      if (parsed.data.usageMinPct !== undefined) f.usageMinPct = parsed.data.usageMinPct;
      if (parsed.data.usageMaxPct !== undefined) f.usageMaxPct = parsed.data.usageMaxPct;
      if (parsed.data.limit !== undefined) f.limit = parsed.data.limit;
      if (parsed.data.sort) f.sort = parsed.data.sort;
      if (parsed.data.sortDir) f.sortDir = parsed.data.sortDir;

      const rows = await cardsReport(db, f);
      request.log.info({ count: rows.length }, '[reports.cards]');
      return { rows };
    },
  );

  fastify.get(
    '/admin/reports/entries',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const parsed = entriesQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      const f: EntriesReportFilters = {};
      const from = toDate(parsed.data.from);
      const to = toDate(parsed.data.to);
      if (from) f.from = from;
      if (to) f.to = to;
      if (parsed.data.customerId) f.customerId = parsed.data.customerId;
      if (parsed.data.cardSerial !== undefined) f.cardSerial = parsed.data.cardSerial;
      if (parsed.data.method) f.method = parsed.data.method;
      const r = toBool(parsed.data.refunded);
      if (r !== undefined) f.refunded = r;
      if (parsed.data.punchedBy) f.punchedBy = parsed.data.punchedBy;
      if (parsed.data.limit !== undefined) f.limit = parsed.data.limit;
      if (parsed.data.offset !== undefined) f.offset = parsed.data.offset;

      const page = await entriesReport(db, f);
      request.log.info({ rows: page.rows.length, total: page.total }, '[reports.entries]');
      return page;
    },
  );

  fastify.get(
    '/admin/reports/revenue',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const parsed = revenueQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      const f: RevenueReportFilters = {};
      const from = toDate(parsed.data.from);
      const to = toDate(parsed.data.to);
      if (from) f.from = from;
      if (to) f.to = to;
      if (parsed.data.groupBy) f.groupBy = parsed.data.groupBy;

      const res = await revenueReport(db, f);
      request.log.info(
        { buckets: res.rows.length, totalCards: res.totalCardsSold },
        '[reports.revenue]',
      );
      return res;
    },
  );

  fastify.get(
    '/admin/reports/cancellations',
    { preHandler: requireRoleHook(...MANAGER_OR_ADMIN) },
    async (request, reply) => {
      const parsed = cancellationsQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      const f: CancellationsReportFilters = {};
      const from = toDate(parsed.data.from);
      const to = toDate(parsed.data.to);
      if (from) f.from = from;
      if (to) f.to = to;
      if (parsed.data.kind) f.kind = parsed.data.kind;
      if (parsed.data.q !== undefined) f.q = parsed.data.q;
      if (parsed.data.limit !== undefined) f.limit = parsed.data.limit;
      if (parsed.data.offset !== undefined) f.offset = parsed.data.offset;

      const page = await cancellationsReport(db, f);
      request.log.info(
        { rows: page.rows.length, total: page.total, cards: page.cardCount, entries: page.entryCount },
        '[reports.cancellations]',
      );
      return page;
    },
  );
};
