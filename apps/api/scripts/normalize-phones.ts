// One-shot migration: normalize every staff.phone and customers.phone row to
// the canonical 05XXXXXXXX form so existing accounts work with the post-fix
// route normalization (anyone typing 0545822079 must match a stored 0545822079,
// not a stored 054-582-2079). Idempotent — re-running is a no-op for rows
// already in canonical form.
//
// Run: `pnpm --filter=@memesh/api seed:normalize-phones`
//
// Set DRY_RUN=1 to print the planned changes without applying them.

import { customers, staff } from '@memesh/db';
import { normalizeIsraeliPhone } from '@memesh/sms';
import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { fileURLToPath } from 'node:url';

type AnyPgDatabase = PgDatabase<any, any, any>;

interface RowChange {
  id: string;
  oldPhone: string;
  newPhone: string;
}

export async function normalizeStaffPhones(
  db: AnyPgDatabase,
  opts: { dryRun?: boolean } = {},
): Promise<{ scanned: number; updated: RowChange[]; skippedInvalid: RowChange[] }> {
  const rows = await db.select({ id: staff.id, phone: staff.phone }).from(staff);
  const updated: RowChange[] = [];
  const skippedInvalid: RowChange[] = [];
  for (const row of rows) {
    let normalized: string;
    try {
      normalized = normalizeIsraeliPhone(row.phone);
    } catch (err) {
      skippedInvalid.push({
        id: row.id,
        oldPhone: row.phone,
        newPhone: err instanceof Error ? err.message : 'invalid',
      });
      continue;
    }
    if (normalized === row.phone) continue;
    updated.push({ id: row.id, oldPhone: row.phone, newPhone: normalized });
    if (!opts.dryRun) {
      await db.update(staff).set({ phone: normalized }).where(eq(staff.id, row.id));
    }
  }
  return { scanned: rows.length, updated, skippedInvalid };
}

export async function normalizeCustomerPhones(
  db: AnyPgDatabase,
  opts: { dryRun?: boolean } = {},
): Promise<{ scanned: number; updated: RowChange[]; skippedInvalid: RowChange[] }> {
  const rows = await db.select({ id: customers.id, phone: customers.phone }).from(customers);
  const updated: RowChange[] = [];
  const skippedInvalid: RowChange[] = [];
  for (const row of rows) {
    let normalized: string;
    try {
      normalized = normalizeIsraeliPhone(row.phone);
    } catch (err) {
      skippedInvalid.push({
        id: row.id,
        oldPhone: row.phone,
        newPhone: err instanceof Error ? err.message : 'invalid',
      });
      continue;
    }
    if (normalized === row.phone) continue;
    updated.push({ id: row.id, oldPhone: row.phone, newPhone: normalized });
    if (!opts.dryRun) {
      await db.update(customers).set({ phone: normalized }).where(eq(customers.id, row.id));
    }
  }
  return { scanned: rows.length, updated, skippedInvalid };
}

// ---------------------------------------------------------------------------
// CLI entry — invoked via `pnpm --filter=@memesh/api seed:normalize-phones`.
// ---------------------------------------------------------------------------

async function runCli(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const { db, pool } = await import('@memesh/db');
  try {
    console.info('[normalize phones] starting', { dryRun });

    const staffResult = await normalizeStaffPhones(db, { dryRun });
    console.info('[normalize phones] staff', {
      scanned: staffResult.scanned,
      updated: staffResult.updated.length,
      skippedInvalid: staffResult.skippedInvalid.length,
    });
    for (const change of staffResult.updated) {
      console.info('[normalize phones] staff updated', change);
    }
    for (const skip of staffResult.skippedInvalid) {
      console.warn('[normalize phones] staff SKIPPED invalid phone', skip);
    }

    const customerResult = await normalizeCustomerPhones(db, { dryRun });
    console.info('[normalize phones] customers', {
      scanned: customerResult.scanned,
      updated: customerResult.updated.length,
      skippedInvalid: customerResult.skippedInvalid.length,
    });
    for (const change of customerResult.updated) {
      console.info('[normalize phones] customer updated', change);
    }
    for (const skip of customerResult.skippedInvalid) {
      console.warn('[normalize phones] customer SKIPPED invalid phone', skip);
    }

    console.info('[normalize phones] done', { dryRun });
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === entryPath) {
  await runCli();
}
