// Read + write for the editable-content overrides (Wave 2 plan 2026-07-13). The
// registry in @memesh/content is the source of truth for keys, defaults, and
// allowed placeholders; this layer stores only the overrides and serves the
// merged map the apps consume. Validation mirrors card-settings: unknown keys,
// length bands, and unknown {{placeholders}} are rejected; a blank value is a
// reset (the row is deleted), never stored empty.

import {
  contentDefaults,
  contentKeys,
  getContentEntry,
  placeholdersIn,
  type ContentMap,
} from '@memesh/content';
import { inArray } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { contentOverrides } from './schema/content-overrides';

type AnyPgDatabase = PgDatabase<any, any, any>;

const SHORT_MAX = 200;
const LONG_MAX = 2000;

export type ContentValidationError =
  | { code: 'unknown_key'; key: string }
  | { code: 'value_too_long'; key: string; max: number }
  | { code: 'unknown_placeholder'; key: string; placeholder: string };

/** Validate a non-empty value against its registry entry. Pure. */
export const validateContentValue = (key: string, value: string): ContentValidationError | null => {
  const entry = getContentEntry(key);
  if (!entry) return { code: 'unknown_key', key };
  const max = entry.kind === 'long' ? LONG_MAX : SHORT_MAX;
  if (value.length > max) return { code: 'value_too_long', key, max };
  const declared = new Set(entry.placeholders ?? []);
  for (const p of placeholdersIn(value)) {
    if (!declared.has(p)) return { code: 'unknown_placeholder', key, placeholder: p };
  }
  return null;
};

/** All overrides as a map (only the keys Yanay changed). */
export const getContentOverrides = async (db: AnyPgDatabase): Promise<ContentMap> => {
  const rows = await db.select().from(contentOverrides);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};

/**
 * The merged, effective content the apps consume: every registry default
 * overlaid with its override. A stale override key (registry entry since
 * removed) is ignored, so a rename can't surface a dangling string.
 */
export const getMergedContent = async (db: AnyPgDatabase): Promise<ContentMap> => {
  const overrides = await getContentOverrides(db);
  const merged: ContentMap = { ...contentDefaults };
  for (const [k, v] of Object.entries(overrides)) {
    if (k in merged) merged[k] = v;
  }
  return merged;
};

export type UpdateContentResult =
  | { ok: true; changed: string[] }
  | { ok: false; error: ContentValidationError };

/**
 * Apply a patch of key → value. A blank (whitespace-only) value resets that key
 * to its default by deleting the row. Validates everything first and writes
 * nothing on any error (fail closed), so a bad key can't partially apply.
 */
export const updateContentOverrides = async (
  db: AnyPgDatabase,
  patch: Record<string, string>,
  updatedBy?: string,
  now: Date = new Date(),
): Promise<UpdateContentResult> => {
  const sets: { key: string; value: string }[] = [];
  const resets: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!contentKeys.has(key)) return { ok: false, error: { code: 'unknown_key', key } };
    const value = raw.trim();
    if (value.length === 0) {
      resets.push(key);
      continue;
    }
    const err = validateContentValue(key, value);
    if (err) return { ok: false, error: err };
    sets.push({ key, value });
  }

  if (sets.length === 0 && resets.length === 0) return { ok: true, changed: [] };

  await db.transaction(async (tx) => {
    for (const s of sets) {
      await tx
        .insert(contentOverrides)
        .values({ key: s.key, value: s.value, updatedAt: now, updatedBy: updatedBy ?? null })
        .onConflictDoUpdate({
          target: contentOverrides.key,
          set: { value: s.value, updatedAt: now, updatedBy: updatedBy ?? null },
        });
    }
    if (resets.length > 0) {
      await tx.delete(contentOverrides).where(inArray(contentOverrides.key, resets));
    }
  });

  return { ok: true, changed: [...sets.map((s) => s.key), ...resets] };
};
