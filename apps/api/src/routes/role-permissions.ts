import { STAFF_ROLES } from '@memesh/auth';
import {
  db,
  getAllRolePermissions,
  isKnownPermission,
  logStaffAction,
  PERMISSIONS,
  CATEGORY_LABELS,
  resetRoleToDefaults,
  setRolePermission,
} from '@memesh/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { invalidatePermissionCache, requireRoleHook } from '../lib/auth-guards.js';

// Catalog descriptor sent to the admin UI. Mirrors PermissionDescriptor from
// @memesh/db, restated here so the wire shape is reviewable in one place and
// future server-only fields on the descriptor don't accidentally leak to the
// client.
interface WirePermissionDescriptor {
  key: string;
  category: string;
  categoryLabel: string;
  label: string;
  description?: string;
}

const wireCatalog = (): WirePermissionDescriptor[] =>
  PERMISSIONS.map((p) => ({
    key: p.key,
    category: p.category,
    categoryLabel: CATEGORY_LABELS[p.category],
    label: p.label,
    ...(p.description !== undefined && { description: p.description }),
  }));

const putBodySchema = z.object({ granted: z.boolean() });
const roleParamSchema = z.enum(STAFF_ROLES);

export const rolePermissionsRoutes: FastifyPluginAsync = async (fastify) => {
  // Read the full matrix. Admin and manager can both see it (the UI surfaces
  // it under ניהול צוות). The manager view is read-only by virtue of every
  // mutation route below requiring admin.
  fastify.get(
    '/role-permissions',
    { preHandler: requireRoleHook('admin', 'manager') },
    async (request) => {
      const grants = await getAllRolePermissions(db);
      request.log.info(
        { role: request.user?.role, permissions: PERMISSIONS.length },
        '[role-permissions api] list',
      );
      return {
        permissions: wireCatalog(),
        roles: STAFF_ROLES,
        grants,
      };
    },
  );

  // Toggle a single (role, permission) tuple. Admin only.
  fastify.put(
    '/role-permissions/:role/:permission',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const params = request.params as { role: string; permission: string };
      const roleParsed = roleParamSchema.safeParse(params.role);
      if (!roleParsed.success) {
        return reply.code(400).send({ error: 'invalid_role' });
      }
      if (!isKnownPermission(params.permission)) {
        return reply.code(400).send({ error: 'unknown_permission' });
      }
      if (roleParsed.data === 'admin') {
        return reply.code(409).send({ error: 'admin_locked' });
      }
      const body = putBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }
      const actor = request.user;
      if (!actor) return reply.code(401).send({ error: 'unauthorized' });

      const row = await setRolePermission(db, {
        role: roleParsed.data,
        permission: params.permission,
        granted: body.data.granted,
        updatedBy: actor.id,
      });
      invalidatePermissionCache(roleParsed.data);

      await logStaffAction(db, {
        staffId: actor.id,
        action: 'update_role_permission',
        summary: `${roleParsed.data} · ${params.permission} → ${body.data.granted ? 'granted' : 'revoked'}`,
      });
      request.log.info(
        {
          actorId: actor.id,
          role: roleParsed.data,
          permission: params.permission,
          granted: body.data.granted,
        },
        '[role-permissions api] update',
      );
      return { row };
    },
  );

  // Reset every grant for a non-admin role to the catalog defaults. Used by
  // the "ברירת מחדל" button in the admin UI.
  fastify.post(
    '/role-permissions/:role/reset',
    { preHandler: requireRoleHook('admin') },
    async (request, reply) => {
      const params = request.params as { role: string };
      const roleParsed = roleParamSchema.safeParse(params.role);
      if (!roleParsed.success) {
        return reply.code(400).send({ error: 'invalid_role' });
      }
      if (roleParsed.data === 'admin') {
        return reply.code(409).send({ error: 'admin_locked' });
      }
      const actor = request.user;
      if (!actor) return reply.code(401).send({ error: 'unauthorized' });

      await resetRoleToDefaults(db, roleParsed.data, actor.id);
      invalidatePermissionCache(roleParsed.data);

      await logStaffAction(db, {
        staffId: actor.id,
        action: 'reset_role_permissions',
        summary: `${roleParsed.data} · reset to defaults`,
      });
      request.log.info(
        { actorId: actor.id, role: roleParsed.data },
        '[role-permissions api] reset to defaults',
      );
      const grants = await getAllRolePermissions(db);
      return { grants };
    },
  );
};
