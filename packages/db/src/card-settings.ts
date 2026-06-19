import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { logStaffAction } from './actions';
import { cardSettings, type CardSettingsRow } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

// Range guards mirror the zod schema in apps/api/src/routes/card-settings.ts.
// Server is the source of truth; the frontend's validation is a UX nicety.
export const CARD_SETTINGS_LIMITS = {
  priceShekels: { min: 0, max: 10000 },
  validityDays: { min: 1, max: 3650 },
  totalEntries: { min: 1, max: 100 },
  pitchLabel: { minLength: 1, maxLength: 200 },
} as const;

export type CardSettingsValidationError =
  | 'price_out_of_range'
  | 'validity_out_of_range'
  | 'entries_out_of_range'
  | 'pitch_length'
  | 'no_changes';

/**
 * Read the singleton settings row. Lazy-init: if the migration seed somehow
 * missed (fresh pglite test DB, manually-applied migration), insert defaults
 * on the first read so callers always get a row back.
 */
export const getCardSettings = async (db: AnyPgDatabase): Promise<CardSettingsRow> => {
  const rows = await db.select().from(cardSettings).limit(1);
  const existing = rows[0];
  if (existing) return existing;
  const inserted = await db.insert(cardSettings).values({}).returning();
  const row = inserted[0];
  if (!row) throw new Error('[getCardSettings] insert returned no row');
  return row;
};

export interface UpdateCardSettingsInput {
  priceShekels?: number | undefined;
  validityDays?: number | undefined;
  totalEntries?: number | undefined;
  pitchLabel?: string | undefined;
  /** Staff member making the change; recorded on the row and in the action log. */
  staffId?: string | undefined;
  /** Override `now` for tests. */
  now?: Date;
}

export type UpdateCardSettingsResult =
  | { ok: true; row: CardSettingsRow; diff: Record<string, [unknown, unknown]> }
  | { ok: false; error: CardSettingsValidationError };

const within = (v: number, min: number, max: number): boolean =>
  Number.isInteger(v) && v >= min && v <= max;

/**
 * Update the singleton settings row. Validates ranges, records who changed
 * what, and writes a staff_actions log entry with a human-readable diff.
 *
 * Returns `no_changes` if the patch leaves every value identical to current —
 * the caller can surface that as a UX hint without writing to the audit log.
 */
export const updateCardSettings = async (
  db: AnyPgDatabase,
  input: UpdateCardSettingsInput,
): Promise<UpdateCardSettingsResult> => {
  // Range guards first — fail fast before touching the row.
  if (
    input.priceShekels !== undefined &&
    !within(
      input.priceShekels,
      CARD_SETTINGS_LIMITS.priceShekels.min,
      CARD_SETTINGS_LIMITS.priceShekels.max,
    )
  ) {
    return { ok: false, error: 'price_out_of_range' };
  }
  if (
    input.validityDays !== undefined &&
    !within(
      input.validityDays,
      CARD_SETTINGS_LIMITS.validityDays.min,
      CARD_SETTINGS_LIMITS.validityDays.max,
    )
  ) {
    return { ok: false, error: 'validity_out_of_range' };
  }
  if (
    input.totalEntries !== undefined &&
    !within(
      input.totalEntries,
      CARD_SETTINGS_LIMITS.totalEntries.min,
      CARD_SETTINGS_LIMITS.totalEntries.max,
    )
  ) {
    return { ok: false, error: 'entries_out_of_range' };
  }
  if (input.pitchLabel !== undefined) {
    const trimmed = input.pitchLabel.trim();
    if (
      trimmed.length < CARD_SETTINGS_LIMITS.pitchLabel.minLength ||
      trimmed.length > CARD_SETTINGS_LIMITS.pitchLabel.maxLength
    ) {
      return { ok: false, error: 'pitch_length' };
    }
  }

  const now = input.now ?? new Date();
  const current = await getCardSettings(db);

  const next: Partial<typeof cardSettings.$inferInsert> = {};
  const diff: Record<string, [unknown, unknown]> = {};

  if (input.priceShekels !== undefined && input.priceShekels !== current.priceShekels) {
    next.priceShekels = input.priceShekels;
    diff.priceShekels = [current.priceShekels, input.priceShekels];
  }
  if (input.validityDays !== undefined && input.validityDays !== current.validityDays) {
    next.validityDays = input.validityDays;
    diff.validityDays = [current.validityDays, input.validityDays];
  }
  if (input.totalEntries !== undefined && input.totalEntries !== current.totalEntries) {
    next.totalEntries = input.totalEntries;
    diff.totalEntries = [current.totalEntries, input.totalEntries];
  }
  if (input.pitchLabel !== undefined) {
    const trimmed = input.pitchLabel.trim();
    if (trimmed !== current.pitchLabel) {
      next.pitchLabel = trimmed;
      diff.pitchLabel = [current.pitchLabel, trimmed];
    }
  }

  if (Object.keys(diff).length === 0) return { ok: false, error: 'no_changes' };

  next.updatedAt = now;
  if (input.staffId !== undefined) next.updatedBy = input.staffId;

  const rows = await db
    .update(cardSettings)
    .set(next)
    .where(eq(cardSettings.id, current.id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error('[updateCardSettings] update returned no row');

  await logStaffAction(db, {
    action: 'update_card_settings',
    summary: summarizeDiff(diff),
    now,
    ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
  });

  return { ok: true, row, diff };
};

// Hebrew-facing summary line for the staff_actions log.
// Example: "עדכון הגדרות כרטיסייה · מחיר 320→340 · כניסות 12→10"
const summarizeDiff = (diff: Record<string, [unknown, unknown]>): string => {
  const parts: string[] = [];
  if (diff.priceShekels) parts.push(`מחיר ${diff.priceShekels[0]}→${diff.priceShekels[1]}`);
  if (diff.validityDays)
    parts.push(`תוקף ${diff.validityDays[0]}→${diff.validityDays[1]} ימים`);
  if (diff.totalEntries)
    parts.push(`כניסות ${diff.totalEntries[0]}→${diff.totalEntries[1]}`);
  if (diff.pitchLabel) parts.push(`טקסט שיווקי עודכן`);
  return `עדכון הגדרות כרטיסייה · ${parts.join(' · ')}`;
};
