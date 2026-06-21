# Plan — Role permissions for ניהול צוות

**Date:** 2026-06-22
**Branch:** feat/phase1-secure-core (active)
**Author:** Yoav + Claude
**Status:** approved — execution starting same session

---

## Goal

Inside ניהול צוות (admin app), let an admin toggle a rich set of capabilities for each non-admin role (`manager`, `cashier`). The `admin` role is always full-power and cannot be downgraded — that is the lock-out safety net. The system must be robust enough that we can add new capabilities later without touching the schema, and the UI must let a lazy admin see at a glance what each role can do.

## Non-goals (deliberate cuts to keep the PR shippable)

1. **No custom roles.** The `staff_role` enum stays as `admin | manager | cashier`. Adding a `roles` table with admin-managed slugs is a bigger migration with cascading FK changes (staff.role, JWT claims, admin nav gating) — out of scope here. Capabilities are configurable per-existing-role, which is the user's actual ask ("options for each role").
2. **No per-user permission overrides.** Permissions are per-role, not per-staff-row. A cashier who needs more rights gets promoted to manager. Per-user overrides are a future iteration.
3. **No backfill of existing role checks at every callsite.** We add the new permission system, enforce it on a handful of new/migrated routes (the staff-management routes themselves and the new role-permissions routes), and leave `requireRoleHook` in place everywhere else. A follow-up PR can migrate site-wide. Mixing both during transition is fine and is how every authz refactor in the wild works.

## Alternatives considered

### Option A — JSONB column on staff table (per-user permissions)
A `permissions jsonb` column on the staff row, each cell `{ "cards.cancel": true, ... }`. Pro: fully granular per-user. Con: drift between users in the same role becomes a mess to audit, and the user explicitly asked for **role-level** controls. Rejected.

### Option B — Separate `roles` + `role_permissions` tables (custom roles)
Promote `staff_role` from enum to FK to a `roles` table; permissions hang off role. Pro: maximally flexible (admins can mint "אחראי משמרת בוקר", "מנהל קופה", etc.). Con: invalidates JWT claims (claim is `role: string` today), breaks the admin-nav `adminOnly` filter, and requires migrating staff.role from enum to text+FK. Big lift for a feature the user can already mostly express by re-purposing the existing three roles. **Rejected for v1; reconsider when there's demand for >3 distinct role profiles.**

### Option C — Role × permission join table (CHOSEN) ✓
Keep the enum. Add `role_permissions (role staff_role, permission varchar(64), granted boolean, updated_at, updated_by)` with composite PK `(role, permission)`. Permission catalog lives in code (typed `PERMISSIONS` array with Hebrew labels + categories). Seed defaults via migration. Admin always granted (hardcoded bypass). Pros: small migration, catalog is type-checked, fully extensible — adding a permission means appending one row to the catalog and one INSERT in seed. Cons: catalog drifts from DB if we forget to seed new entries (mitigated by a lazy "ensure default exists" insert at read time and a startup audit log).

## Permission catalog (the "many options")

Grouped by feature area. Each has a stable string key, a Hebrew label, an optional Hebrew description, and a category. Defaults shown as `A/M/C` (admin / manager / cashier).

**Staff (ניהול צוות)**
- `staff.view` — צפייה בצוות — A/M/-
- `staff.create` — הוספת איש צוות — A/-/-
- `staff.edit` — עריכת איש צוות — A/-/-
- `staff.delete` — מחיקת איש צוות — A/-/-
- `staff.change_role` — שינוי תפקיד — A/-/-
- `staff.deactivate` — השעיית איש צוות — A/-/-
- `staff.manage_pin` — ניהול קוד אישי לקופאי — A/M/-
- `staff.reset_password` — איפוס סיסמה לאיש צוות — A/-/-
- `staff.manage_permissions` — ניהול הרשאות לתפקידים — A/-/-

**Customers (לקוחות)**
- `customers.view` — צפייה ברשימת לקוחות — A/M/C
- `customers.view_contact` — צפייה בפרטי קשר (טלפון/אימייל) — A/M/C
- `customers.create` — רישום לקוח חדש — A/M/C
- `customers.edit` — עריכת לקוח — A/M/-
- `customers.delete` — מחיקת לקוח — A/-/-

**Cards (כרטיסיות)**
- `cards.view` — צפייה בכרטיסיות — A/M/C
- `cards.create` — מכירת כרטיסייה — A/M/C
- `cards.edit` — עריכת כרטיסייה — A/M/-
- `cards.cancel` — ביטול כרטיסייה — A/M/-
- `cards.reassign` — העברת כרטיסייה ללקוח אחר — A/M/-
- `cards.refund_entry` — החזר ניקוב — A/M/-

**Punches (ניקובים)**
- `punches.create` — ניקוב כניסה — A/M/C
- `punches.reverse` — ביטול ניקוב — A/M/-

**Reports (דוחות)**
- `reports.view_basic` — צפייה בדוחות תפעוליים — A/M/-
- `reports.view_financial` — צפייה בדוחות כספיים — A/-/-
- `reports.export` — ייצוא דוחות — A/M/-

**Settings (הגדרות)**
- `settings.view` — צפייה בהגדרות — A/-/-
- `settings.edit_card_settings` — עריכת הגדרות כרטיסייה — A/-/-
- `settings.edit_brand` — עריכת מיתוג — A/-/-
- `settings.edit_integrations` — עריכת אינטגרציות — A/-/-

**Audit (יומן פעולות)**
- `audit.view` — צפייה ביומן פעולות צוות — A/M/-

Total: 28 permissions across 7 categories. Robust enough to cover the asks; small enough to render in one screen.

## Schema

```sql
CREATE TABLE role_permissions (
  role staff_role NOT NULL,
  permission varchar(64) NOT NULL,
  granted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES staff(id) ON DELETE SET NULL,
  PRIMARY KEY (role, permission)
);
```

No FK to a `permissions` table on purpose — the catalog is code-owned. Future deletions of a permission key are handled by leaving the row in place (ignored at read time) or by an explicit cleanup migration.

Seed: INSERT INTO ... ON CONFLICT DO NOTHING for every (role, permission) tuple in the catalog using the defaults above. Re-running the seed never overwrites a hand-edited row.

## API

- `GET /role-permissions` — admin or manager. Returns `{ permissions: PermissionDescriptor[], grants: { [role]: { [permission]: boolean } } }`. Manager can see the matrix but cannot toggle.
- `PUT /role-permissions/:role/:permission` body `{ granted: boolean }` — admin only. Refuses to touch `admin` rows (always returns 409 `admin_locked`). Refuses an unknown permission key. Logs to `staff_actions` with action `update_role_permission` and a summary like `manager · cards.cancel → granted`.

## Guard

`requirePermissionHook(permission: PermissionKey): preHandlerHookHandler`. Reads from an in-process cache (Map keyed by role; TTL 30 s; invalidated immediately after a PUT). Admin role short-circuits to allowed before the cache lookup. Unknown user → 401. Missing permission → 403 with `{ error: 'forbidden', missing: permission }` so the client can show a helpful message.

## Frontend

New tab inside `Staff` component: `הרשאות`. Top of the staff card has two tabs — `צוות` (existing list) and `הרשאות` (new matrix).

Matrix UI:
- Rows = permission categories (collapsible), each containing its permissions.
- Columns = `admin` (locked, all on, visually muted), `manager`, `cashier`.
- Cells = a toggle switch. Saves on flip (optimistic UI; revert on error). Disabled cells get a tooltip explaining why.
- Top-right of the tab has a tiny "ברירת מחדל" button per non-admin column that resets that column to the seeded defaults (admin confirmation modal).

## Security

- Only admin can PUT. Enforced both by `requireRoleHook('admin')` and by the route refusing to mutate `admin` rows.
- The `admin` role is hardcoded as always-permitted at the guard layer — even if a stray UPDATE flips an admin row in the DB, the system still treats admin as full-power. This is the lock-out safety net (rule 13: fail closed for non-admins, fail open for admins, never leave the org unable to administer itself).
- Every mutation writes to `staff_actions` (the existing audit log) with the diff. The log already exists; we add `update_role_permission` to the action type.
- Permission keys are validated against the static catalog before the UPDATE runs — no free-form keys reach the DB.

## Observability

Every relevant step logs with a namespace:
- `[role-permissions cache]` — boot load, TTL refresh, invalidation
- `[role-permissions api]` — list, update (with role/permission/granted)
- `[role-permissions guard]` — allow/deny, with role + permission + decision reason
- Admin app: `[admin permissions]` — tab opened, toggle clicked (optimistic), save success/fail

Booleans are logged with their values, never as bare strings.

## Settings audit

This feature *is* the settings layer for permissions. New controls:
- The permission matrix itself (in ניהול צוות → הרשאות).
- "Reset to default" per role (button).

Nothing else needs to be promoted to settings.

## Testing

- DB query tests: read-after-write, seed idempotency, list returns every catalog entry, unknown role/permission rejected.
- API route tests: admin can PUT, manager gets 403 on PUT, admin row is locked, unknown permission returns 400, audit log row created on each PUT, GET shape matches contract.
- Frontend: not testing the UI in this PR (no test harness for components today); covered by manual QA per rule 6.

## Files touched

- `packages/db/src/schema/role-permissions.ts` (new)
- `packages/db/src/schema/staff-actions.ts` (add `update_role_permission` action type comment)
- `packages/db/src/schema/index.ts` (export)
- `packages/db/src/permissions-catalog.ts` (new — the 28-entry catalog)
- `packages/db/src/role-permissions.ts` + `.test.ts` (new)
- `packages/db/src/index.ts` (export)
- `packages/db/migrations/0010_role_permissions.sql` (new — CREATE TABLE + seed)
- `packages/db/migrations/meta/_journal.json` (add entry 10)
- `packages/db/migrations/meta/0010_snapshot.json` (new)
- `apps/api/src/lib/auth-guards.ts` (add `requirePermissionHook`)
- `apps/api/src/routes/role-permissions.ts` + `.test.ts` (new)
- `apps/api/src/app.ts` (register route)
- `apps/admin/src/lib/api/role-permissions.ts` (new)
- `apps/admin/src/admin/AdminApp.tsx` (Staff tab → Permissions matrix; keep Staff list as-is)

## Open questions (deferred)

- Custom roles ("אחראי משמרת" as a distinct slug from "מנהל") — track demand; revisit in 2-3 months.
- Per-user overrides — same.
- Time-bound permissions (grant for a shift only) — out of scope; add later if asked.
