import { hashPassword, verifyPassword } from '@memesh/auth';
import { createStaff, MIGRATIONS_FOLDER, staff } from '@memesh/db';
import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { fileURLToPath } from 'node:url';

type AnyPgDatabase = PgDatabase<any, any, any>;

const MIN_PASSWORD_LENGTH = 12;

export interface SeedAdminInput {
  phone: string;
  password: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  /**
   * When true and a staff row with the given phone already exists, the
   * password hash is overwritten (and the row is reactivated). Used for
   * the "I forgot the admin password" recovery path during onboarding.
   * Disabled by default so accidental re-runs never silently change
   * credentials.
   */
  forceResetPassword?: boolean;
}

export type SeedAdminResult =
  | { kind: 'created'; id: string; phone: string }
  | { kind: 'already_seeded'; id: string; phone: string }
  | { kind: 'password_reset'; id: string; phone: string };

/**
 * Create the first admin staff member, idempotently. Calling this twice with the
 * same phone is a no-op on the second call (returns `already_seeded`).
 *
 * The caller owns the db instance and is responsible for running migrations
 * before calling this. The CLI entry below handles both for the operator.
 */
export async function seedAdmin(
  db: AnyPgDatabase,
  input: SeedAdminInput,
): Promise<SeedAdminResult> {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`[seed admin] password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const existing = await db.select().from(staff).where(eq(staff.phone, input.phone)).limit(1);
  const found = existing[0];
  if (found) {
    if (input.forceResetPassword) {
      console.info('[seed admin] resetting password for existing row', {
        phone: input.phone,
        id: found.id,
      });
      const passwordHash = await hashPassword(input.password);
      await db
        .update(staff)
        .set({ passwordHash, isActive: true, updatedAt: new Date() })
        .where(eq(staff.id, found.id));
      console.info('[seed admin] password reset done', { id: found.id, phone: found.phone });
      return { kind: 'password_reset', id: found.id, phone: found.phone };
    }
    console.info('[seed admin] already seeded, no-op', { phone: input.phone, id: found.id });
    return { kind: 'already_seeded', id: found.id, phone: found.phone };
  }
  console.info('[seed admin] hashing password', { phone: input.phone });
  const passwordHash = await hashPassword(input.password);
  const row = await createStaff(db, {
    firstName: input.firstName ?? 'Admin',
    lastName: input.lastName ?? 'User',
    phone: input.phone,
    passwordHash,
    role: 'admin',
    ...(input.email !== undefined && { email: input.email }),
  });
  console.info('[seed admin] created', { id: row.id, phone: row.phone, role: row.role });
  return { kind: 'created', id: row.id, phone: row.phone };
}

/** Convenience for tests and ad-hoc verification — checks a plaintext password against the seeded hash. */
export async function verifySeededPassword(
  db: AnyPgDatabase,
  phone: string,
  password: string,
): Promise<boolean> {
  const rows = await db.select().from(staff).where(eq(staff.phone, phone)).limit(1);
  const row = rows[0];
  if (!row || !row.passwordHash) return false;
  return verifyPassword(password, row.passwordHash);
}

// ---------------------------------------------------------------------------
// CLI entry — invoked directly via `pnpm seed:admin`. Runs migrations against
// the real Postgres (env-supplied DATABASE_URL), then seeds the first admin.
// ---------------------------------------------------------------------------

async function runCli(): Promise<void> {
  const phone = process.env.SEED_ADMIN_PHONE;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const firstName = process.env.SEED_ADMIN_FIRST_NAME;
  const lastName = process.env.SEED_ADMIN_LAST_NAME;
  const email = process.env.SEED_ADMIN_EMAIL;
  const forceResetPassword =
    process.env.SEED_ADMIN_FORCE_RESET === '1' || process.env.SEED_ADMIN_FORCE_RESET === 'true';

  if (!phone || !password) {
    console.error('[seed admin] SEED_ADMIN_PHONE and SEED_ADMIN_PASSWORD are required');
    process.exit(1);
  }

  // Lazy-import the production client + drizzle migrator so test runs (which
  // pass their own db) never construct the pg Pool.
  const [{ db, pool }, { migrate }] = await Promise.all([
    import('@memesh/db'),
    import('drizzle-orm/node-postgres/migrator'),
  ]);

  try {
    console.info('[seed admin] running migrations', { migrationsFolder: MIGRATIONS_FOLDER });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.info('[seed admin] migrations done');

    const result = await seedAdmin(db, {
      phone,
      password,
      forceResetPassword,
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(email !== undefined && { email }),
    });
    console.info('[seed admin] done', result);
  } finally {
    await pool.end();
  }
}

// Run when this file is the process entrypoint (tsx scripts/seed-admin.ts), not when imported by tests.
const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === entryPath) {
  await runCli();
}
