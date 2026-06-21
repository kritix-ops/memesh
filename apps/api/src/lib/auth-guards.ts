import type { StaffRole } from '@memesh/auth';
import { db, getRolePermissions, isKnownPermission } from '@memesh/db';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

export const requireAuthHook: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  if (!request.user) {
    request.log.info({ path: request.url }, '[api auth] unauthorized');
    return reply.code(401).send({ error: 'unauthorized' });
  }
};

export const requireRoleHook =
  (...roles: StaffRole[]): preHandlerHookHandler =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      request.log.info({ path: request.url }, '[api auth] unauthorized');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!roles.includes(request.user.role)) {
      request.log.info(
        { path: request.url, role: request.user.role, allowed: roles },
        '[api auth] forbidden',
      );
      return reply.code(403).send({ error: 'forbidden' });
    }
  };

// ---------------------------------------------------------------------------
// Permission-based guard (added 2026-06-22 alongside the role_permissions
// matrix). Caches per-role grant maps in-process with a short TTL so the hot
// path is one Map lookup. Admin short-circuits to always-allowed BEFORE the
// cache load — that is the lock-out safety net (rule 13: the org must never
// be unable to administer itself, even if the DB rows for admin are stale or
// missing). The cache is invalidated explicitly by the role-permissions
// route after a successful PUT so the new grant is visible immediately.
// ---------------------------------------------------------------------------

interface CachedGrants {
  grants: Record<string, boolean>;
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
const permissionCache = new Map<StaffRole, CachedGrants>();

const loadGrants = async (role: StaffRole): Promise<Record<string, boolean>> => {
  const grants = await getRolePermissions(db, role);
  permissionCache.set(role, { grants, loadedAt: Date.now() });
  return grants;
};

const grantsFor = async (role: StaffRole): Promise<Record<string, boolean>> => {
  const cached = permissionCache.get(role);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.grants;
  return loadGrants(role);
};

/** Drop one role's cached grants. Call after a PUT mutates that role's row. */
export const invalidatePermissionCache = (role?: StaffRole): void => {
  if (role) {
    permissionCache.delete(role);
  } else {
    permissionCache.clear();
  }
};

export const requirePermissionHook =
  (permission: string): preHandlerHookHandler =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      request.log.info({ path: request.url, permission }, '[api auth] unauthorized');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    // Admin always allowed — see lock-out safety net comment above.
    if (request.user.role === 'admin') return;

    if (!isKnownPermission(permission)) {
      // A route asked for a permission that no longer exists in the catalog.
      // Fail closed for non-admins; log loudly so the operator sees it.
      request.log.error(
        { path: request.url, permission, role: request.user.role },
        '[role-permissions guard] unknown permission key — failing closed',
      );
      return reply.code(403).send({ error: 'forbidden', missing: permission });
    }

    const grants = await grantsFor(request.user.role);
    const allowed = grants[permission] === true;
    if (!allowed) {
      request.log.info(
        { path: request.url, role: request.user.role, permission, decision: 'deny' },
        '[role-permissions guard] deny',
      );
      return reply.code(403).send({ error: 'forbidden', missing: permission });
    }
    request.log.debug(
      { path: request.url, role: request.user.role, permission, decision: 'allow' },
      '[role-permissions guard] allow',
    );
  };
