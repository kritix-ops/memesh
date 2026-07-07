import {
  db,
  setHolidayPolicy,
  venueTodayIso,
  type HolidayPolicy,
  type HolidayPolicyPatch,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { requireRoleHook } from '../lib/auth-guards.js';
import { createHebcalClient, type HebcalGeo } from '../lib/hebcal-client.js';
import {
  buildHolidayCalendar,
  regenerateHolidayRulesForYear,
  runHolidaySync,
  type HolidaySyncDeps,
} from '../lib/holiday-sync.js';

// Admin-only Jewish-holiday + Shabbat closures (plan 2026-07-07-jewish-holidays-
// closures). GET the browse calendar, PATCH one holiday's decision, POST to run
// the yearly Hebcal sync. Hebcal reachability only affects these admin actions —
// the resolver reads stored rules, so sales are never blocked by Hebcal.

const hebcal = createHebcalClient();
const geo: HebcalGeo = { kind: 'geoname', geonameid: env.HEBCAL_VENUE_GEONAMEID };
const deps = (): HolidaySyncDeps => ({ db, hebcal, geo });

const YEAR_MIN = 2020;
const YEAR_MAX = 2100;
const yearSchema = z.coerce.number().int().min(YEAR_MIN).max(YEAR_MAX);
const currentYear = (): number => Number(venueTodayIso().slice(0, 4));

const patchSchema = z
  .object({
    year: yearSchema,
    policy: z.enum(['normal', 'closed', 'special_hours']).optional(),
    openTime: z.string().nullable().optional(),
    closeTime: z.string().nullable().optional(),
    shabbatCloseOffsetMinutes: z.number().int().nullable().optional(),
    note: z.string().max(120).nullable().optional(),
    confirmed: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, { message: 'no fields to update besides year' });

// Serialize a stored policy for the SPA: TIME 'HH:MM:SS' → 'HH:MM', confirmed_at
// → boolean.
function serializePolicy(p: HolidayPolicy) {
  return {
    holidayKey: p.holidayKey,
    hebrewName: p.hebrewName,
    category: p.category,
    yomtov: p.yomtov,
    policy: p.policy,
    openTime: p.openTime ? p.openTime.slice(0, 5) : null,
    closeTime: p.closeTime ? p.closeTime.slice(0, 5) : null,
    shabbatCloseOffsetMinutes: p.shabbatCloseOffsetMinutes,
    note: p.note,
    confirmed: p.confirmedAt != null,
  };
}

export const holidaysAdminRoutes: FastifyPluginAsync = async (fastify) => {
  // The browse calendar for a year: every holiday + Shabbat with its date(s)
  // and current decision.
  fastify.get('/admin/holidays', { preHandler: requireRoleHook('admin') }, async (request, reply) => {
    const parsed = yearSchema.safeParse((request.query as { year?: unknown })?.year ?? currentYear());
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_year' });
    try {
      const cal = await buildHolidayCalendar(deps(), parsed.data);
      request.log.info({ year: parsed.data, entries: cal.entries.length }, '[holidays admin calendar]');
      return cal;
    } catch (err) {
      request.log.error({ err, year: parsed.data }, '[holidays admin calendar] hebcal fetch failed');
      return reply.code(503).send({ error: 'hebcal_unavailable' });
    }
  });

  // Run the yearly sync: pull Hebcal, upsert policies, regenerate the year's rules.
  fastify.post('/admin/holidays/sync', { preHandler: requireRoleHook('admin') }, async (request, reply) => {
    const parsed = yearSchema.safeParse((request.query as { year?: unknown })?.year ?? currentYear());
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_year' });
    try {
      return await runHolidaySync(deps(), parsed.data, new Date());
    } catch (err) {
      request.log.error({ err, year: parsed.data }, '[holidays admin sync] failed');
      return reply.code(503).send({ error: 'hebcal_unavailable' });
    }
  });

  // Set one holiday's decision, then re-materialize the viewed year so it
  // reaches the resolver immediately.
  fastify.patch('/admin/holidays/:key', { preHandler: requireRoleHook('admin') }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    // Build the patch explicitly so optional keys are never set to `undefined`
    // (exactOptionalPropertyTypes rejects that against HolidayPolicyPatch).
    const d = parsed.data;
    const patch: HolidayPolicyPatch = {};
    if (d.policy !== undefined) patch.policy = d.policy;
    if (d.openTime !== undefined) patch.openTime = d.openTime;
    if (d.closeTime !== undefined) patch.closeTime = d.closeTime;
    if (d.shabbatCloseOffsetMinutes !== undefined) patch.shabbatCloseOffsetMinutes = d.shabbatCloseOffsetMinutes;
    if (d.note !== undefined) patch.note = d.note;
    if (d.confirmed !== undefined) patch.confirmed = d.confirmed;

    const res = await setHolidayPolicy(db, key, patch, new Date());
    if (!res.ok) {
      return reply.code(res.error === 'not_found' ? 404 : 400).send({ error: res.error });
    }

    try {
      const regenerated = await regenerateHolidayRulesForYear(deps(), d.year, new Date());
      request.log.info({ key, policy: res.policy.policy, year: d.year, regenerated }, '[holidays admin set]');
      return { policy: serializePolicy(res.policy), regenerated };
    } catch (err) {
      // The decision is saved; only the rule refresh failed (Hebcal down). Report
      // it so the UI can prompt a manual sync, but the 200 keeps the save.
      request.log.error({ err, key }, '[holidays admin set] regenerate failed (policy saved)');
      return { policy: serializePolicy(res.policy), regenerated: null, warning: 'rules_not_refreshed' };
    }
  });
};
