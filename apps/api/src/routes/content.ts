import {
  db,
  getContentOverrides,
  getMergedContent,
  updateContentOverrides,
  type ContentValidationError,
} from '@memesh/db';
import type { ContentMap } from '@memesh/content';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRoleHook } from '../lib/auth-guards.js';

// Editable-content delivery + admin editing (Wave 2 plan 2026-07-13). GET
// /content serves the merged (default ?? override) map every app fetches once on
// boot; the admin surface reads the raw overrides and PATCHes changes. Range /
// placeholder validation lives in the DB helper; this route shapes the request
// and maps the error, mirroring round-settings.ts.

// A short in-memory cache for the public map — apps fetch once per boot, but a
// burst of cold starts shouldn't each hit the DB. Invalidated on any edit (this
// instance); other instances refresh within the TTL. Per-instance, like the
// staff-rounds cache.
const CACHE_TTL_MS = 30_000;
let cache: { content: ContentMap; expiresAt: number } | null = null;

// Test seam — reset between assertions (the cache is module-level).
export function _resetContentCacheForTests(): void {
  cache = null;
}

const validationStatus: Record<ContentValidationError['code'], number> = {
  unknown_key: 400,
  value_too_long: 400,
  unknown_placeholder: 400,
};

const patchSchema = z.object({ patch: z.record(z.string()) }).strict();

export const contentRoutes: FastifyPluginAsync = async (fastify) => {
  // Public — the strings are already visible in the app. Rate-limited like the
  // other public reads.
  fastify.get(
    '/content',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => {
      const now = Date.now();
      if (cache && cache.expiresAt > now) return { content: cache.content };
      const content = await getMergedContent(db);
      cache = { content, expiresAt: now + CACHE_TTL_MS };
      return { content };
    },
  );

  // Admin editor reads the raw overrides (which keys are customised + their
  // values); the registry metadata is bundled in the admin app.
  fastify.get('/admin/content', { preHandler: requireRoleHook('admin') }, async () => {
    const overrides = await getContentOverrides(db);
    return { overrides };
  });

  fastify.patch(
    '/admin/content',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const result = await updateContentOverrides(db, parsed.data.patch, request.user?.id);
      if (!result.ok) {
        return reply.code(validationStatus[result.error.code]).send({ error: result.error });
      }
      cache = null; // an edit invalidates the public map on this instance
      request.log.info({ changed: result.changed, by: request.user?.id }, '[content edit] saved');
      return { changed: result.changed };
    },
  );
};
