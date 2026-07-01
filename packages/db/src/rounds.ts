// Admin CRUD for round templates + idempotent materialization of their
// per-date `round_instances`. The dashboard reads round_instances, so creating
// a template alone shows nothing — every write path here also ensures the
// upcoming instances exist. Pattern mirrors card-settings/dashboard-settings:
// pure validation, then persist; helpers return a discriminated result.

import { and, asc, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  bookings,
  roundInstances,
  roundOffDates,
  roundReminderLog,
  rounds,
  waitlistEntries,
  type NewRoundInstance,
  type Round,
} from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

// Rolling window of days for which instances are kept materialized. On-view
// top-up (see ensureAllActiveInstances) keeps it rolling as the admin uses the
// screen; a daily cron can replace that later.
export const INSTANCE_HORIZON_DAYS = 30;

const CAPACITY_MIN = 1;
const CAPACITY_MAX = 100_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type RoundInput = {
  label: string;
  displayName: string;
  /** "HH:MM" */
  startTime: string;
  /** "HH:MM" */
  endTime: string;
  /** Weekday bitmask, bit 0 = Sunday … bit 6 = Saturday. 1..127. */
  daysActive: number;
  defaultCapacity: number;
  isActive?: boolean;
  sortOrder?: number;
};

export type RoundPatch = Partial<RoundInput>;

export type RoundValidationError =
  | { code: 'label_length' }
  | { code: 'display_name_length' }
  | { code: 'invalid_start_time' }
  | { code: 'invalid_end_time' }
  | { code: 'end_not_after_start' }
  | { code: 'capacity_out_of_range'; min: number; max: number }
  | { code: 'days_active_out_of_range' }
  | { code: 'sort_order_invalid' };

/** "HH:MM" → minutes since midnight. Assumes the string already matches TIME_RE. */
function toMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * Validate a create input (all fields required) or, when `partial` is true, an
 * update patch (only the provided fields, with cross-field checks resolved
 * against `current`). Returns the first problem or null. Pure — no DB calls.
 */
export function validateRoundInput(
  input: RoundInput | RoundPatch,
  current?: Round,
): RoundValidationError | null {
  const label = input.label;
  if (label !== undefined && (label.trim().length < 1 || label.trim().length > 64)) {
    return { code: 'label_length' };
  }
  const displayName = input.displayName;
  if (
    displayName !== undefined &&
    (displayName.trim().length < 1 || displayName.trim().length > 128)
  ) {
    return { code: 'display_name_length' };
  }
  if (input.startTime !== undefined && !TIME_RE.test(input.startTime)) {
    return { code: 'invalid_start_time' };
  }
  if (input.endTime !== undefined && !TIME_RE.test(input.endTime)) {
    return { code: 'invalid_end_time' };
  }
  // Resolve start/end against current for the cross-field check on a patch.
  const start = input.startTime ?? (current ? hhmm(current.startTime) : undefined);
  const end = input.endTime ?? (current ? hhmm(current.endTime) : undefined);
  if (start !== undefined && end !== undefined && TIME_RE.test(start) && TIME_RE.test(end)) {
    if (toMinutes(end) <= toMinutes(start)) return { code: 'end_not_after_start' };
  }
  if (input.defaultCapacity !== undefined) {
    if (
      !Number.isInteger(input.defaultCapacity) ||
      input.defaultCapacity < CAPACITY_MIN ||
      input.defaultCapacity > CAPACITY_MAX
    ) {
      return { code: 'capacity_out_of_range', min: CAPACITY_MIN, max: CAPACITY_MAX };
    }
  }
  if (input.daysActive !== undefined) {
    if (!Number.isInteger(input.daysActive) || input.daysActive < 1 || input.daysActive > 127) {
      return { code: 'days_active_out_of_range' };
    }
  }
  if (input.sortOrder !== undefined && !Number.isInteger(input.sortOrder)) {
    return { code: 'sort_order_invalid' };
  }
  return null;
}

export type CreateRoundResult =
  | { ok: true; round: Round }
  | { ok: false; error: RoundValidationError };

/** Create a round template + materialize its upcoming instances. */
export const createRound = async (
  db: AnyPgDatabase,
  input: RoundInput,
  now: Date = new Date(),
): Promise<CreateRoundResult> => {
  const error = validateRoundInput(input);
  if (error) return { ok: false, error };
  const inserted = await db
    .insert(rounds)
    .values({
      label: input.label.trim(),
      displayName: input.displayName.trim(),
      startTime: input.startTime,
      endTime: input.endTime,
      daysActive: input.daysActive,
      defaultCapacity: input.defaultCapacity,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  const round = inserted[0];
  if (!round) throw new Error('[rounds] create returned no row');
  await ensureUpcomingInstances(db, round, now);
  return { ok: true, round };
};

export type UpdateRoundResult =
  | { ok: true; round: Round }
  | { ok: false; error: RoundValidationError }
  | { ok: false; notFound: true };

/** Edit a round template (partial). Re-materializes upcoming instances so a
 *  newly-added weekday or a re-activation starts appearing immediately. */
export const updateRound = async (
  db: AnyPgDatabase,
  id: string,
  patch: RoundPatch,
  now: Date = new Date(),
): Promise<UpdateRoundResult> => {
  const existing = await db.select().from(rounds).where(eq(rounds.id, id)).limit(1);
  const current = existing[0];
  if (!current) return { ok: false, notFound: true };

  const error = validateRoundInput(patch, current);
  if (error) return { ok: false, error };

  const next: Partial<typeof rounds.$inferInsert> = { updatedAt: now };
  if (patch.label !== undefined) next.label = patch.label.trim();
  if (patch.displayName !== undefined) next.displayName = patch.displayName.trim();
  if (patch.startTime !== undefined) next.startTime = patch.startTime;
  if (patch.endTime !== undefined) next.endTime = patch.endTime;
  if (patch.daysActive !== undefined) next.daysActive = patch.daysActive;
  if (patch.defaultCapacity !== undefined) next.defaultCapacity = patch.defaultCapacity;
  if (patch.isActive !== undefined) next.isActive = patch.isActive;
  if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder;

  const updated = await db.update(rounds).set(next).where(eq(rounds.id, id)).returning();
  const round = updated[0];
  if (!round) throw new Error('[rounds] update returned no row');
  await ensureUpcomingInstances(db, round, now);
  return { ok: true, round };
};

/** All round templates, ordered for the admin list (sort_order, then start). */
export const listRounds = async (db: AnyPgDatabase): Promise<Round[]> => {
  return db.select().from(rounds).orderBy(asc(rounds.sortOrder), asc(rounds.startTime));
};

export type DeleteRoundResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'has_bookings' };

/**
 * Hard-delete a round template and its instances — allowed only when NO
 * booking (any status, including cancelled) ever touched it, because bookings
 * are the money/audit trail. With history, the admin deactivates instead.
 * Waitlist entries and reminder-log rows are not history in that sense, so
 * they go with the round.
 */
export const deleteRound = async (db: AnyPgDatabase, id: string): Promise<DeleteRoundResult> => {
  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: rounds.id }).from(rounds).where(eq(rounds.id, id)).limit(1);
    if (!existing[0]) return { ok: false, error: 'not_found' as const };

    const instRows = await tx
      .select({ id: roundInstances.id })
      .from(roundInstances)
      .where(eq(roundInstances.roundId, id));
    const instIds = instRows.map((r) => r.id);
    if (instIds.length > 0) {
      const booked = await tx
        .select({ n: count() })
        .from(bookings)
        .where(inArray(bookings.roundInstanceId, instIds));
      if (Number(booked[0]?.n ?? 0) > 0) return { ok: false, error: 'has_bookings' as const };

      await tx.delete(roundReminderLog).where(inArray(roundReminderLog.roundInstanceId, instIds));
      await tx.delete(waitlistEntries).where(inArray(waitlistEntries.roundInstanceId, instIds));
      await tx.delete(roundInstances).where(eq(roundInstances.roundId, id));
    }
    await tx.delete(rounds).where(eq(rounds.id, id));
    return { ok: true as const };
  });
};

export type DuplicateRoundResult =
  | { ok: true; round: Round }
  | { ok: false; error: 'not_found' };

/** Suffix a name with the copy marker, keeping it inside the column limit. */
const copyName = (base: string, max: number): string => {
  const suffix = ' (עותק)';
  return base.length + suffix.length <= max
    ? `${base}${suffix}`
    : `${base.slice(0, max - suffix.length)}${suffix}`;
};

/**
 * Duplicate a round template. The copy is created INACTIVE so it never goes
 * live before the admin reviews and renames it — activating it (or any edit)
 * materializes its instances through the normal update path.
 */
export const duplicateRound = async (
  db: AnyPgDatabase,
  id: string,
): Promise<DuplicateRoundResult> => {
  const existing = await db.select().from(rounds).where(eq(rounds.id, id)).limit(1);
  const current = existing[0];
  if (!current) return { ok: false, error: 'not_found' as const };

  const inserted = await db
    .insert(rounds)
    .values({
      label: copyName(current.label, 64),
      displayName: copyName(current.displayName, 128),
      startTime: current.startTime,
      endTime: current.endTime,
      daysActive: current.daysActive,
      defaultCapacity: current.defaultCapacity,
      isActive: false,
      sortOrder: current.sortOrder,
    })
    .returning();
  const round = inserted[0];
  if (!round) throw new Error('[rounds] duplicate returned no row');
  return { ok: true as const, round };
};

// ---------------------------------------------------------------------------
// Customer-facing availability (Super Brief §1.3 + Appendix A)
// ---------------------------------------------------------------------------

export interface RoundAvailabilityRow {
  roundInstanceId: string;
  roundId: string;
  /** Customer-facing round name. */
  label: string;
  /** "HH:MM" */
  startTime: string;
  /** "HH:MM" */
  endTime: string;
  capacity: number;
  /** confirmed + used + active holds (child bookings; companions never count). */
  taken: number;
  /** max(0, capacity − taken). */
  available: number;
  isClosed: boolean;
}

/**
 * Live availability for every ACTIVE round on a given date. Pure read — the
 * count follows super-brief §1.3: capacity minus confirmed + used + active
 * holds, counting child bookings only (companions are a booking column, never a
 * separate row, so counting bookings counts children). Expired holds are
 * ignored (lazy expiry). Sorted by start time.
 *
 * Reads whatever round_instances already exist for the date; materialization is
 * the admin write-path's job (a date past the rolling window returns nothing
 * until it's topped up).
 */
export const roundAvailabilityForDate = async (
  db: AnyPgDatabase,
  dateIso: string,
  now: Date = new Date(),
): Promise<RoundAvailabilityRow[]> => {
  const instances = await db
    .select({
      id: roundInstances.id,
      roundId: roundInstances.roundId,
      capacity: roundInstances.capacity,
      isClosed: roundInstances.isClosed,
      label: rounds.displayName,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
    })
    .from(roundInstances)
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(and(eq(roundInstances.date, dateIso), eq(rounds.isActive, true)));

  const result: RoundAvailabilityRow[] = [];
  for (const inst of instances) {
    const takenRows = await db
      .select({ n: count() })
      .from(bookings)
      .where(
        and(
          eq(bookings.roundInstanceId, inst.id),
          sql`(${bookings.status} IN ('confirmed','used') OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))`,
        ),
      );
    const taken = Number(takenRows[0]?.n ?? 0);
    result.push({
      roundInstanceId: inst.id,
      roundId: inst.roundId,
      label: inst.label,
      startTime: hhmm(inst.startTime),
      endTime: hhmm(inst.endTime),
      capacity: inst.capacity,
      taken,
      available: Math.max(0, inst.capacity - taken),
      isClosed: inst.isClosed,
    });
  }

  result.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return result;
};

/**
 * Is the rounds system in use at all — any active round template? The WP
 * product-page picker uses this to decide whether choosing a round is
 * mandatory (Yanay 2026-07-02: with no rounds configured, entry tickets sell
 * as plain products; once rounds exist, picking one is required).
 */
export const anyActiveRounds = async (db: AnyPgDatabase): Promise<boolean> => {
  const rows = await db
    .select({ id: rounds.id })
    .from(rounds)
    .where(eq(rounds.isActive, true))
    .limit(1);
  return rows.length > 0;
};

// ---------------------------------------------------------------------------
// Off dates — days on which the rounds system is switched off entirely
// (Yoav 2026-07-02). Not "closed" (no sales) but "free play": tickets sell
// without a round and availability reports roundsRequired=false.
// ---------------------------------------------------------------------------

/** All off dates, soonest first. Past dates are harmless clutter the admin can remove. */
export const listRoundOffDates = async (db: AnyPgDatabase): Promise<string[]> => {
  const rows = await db.select({ date: roundOffDates.date }).from(roundOffDates).orderBy(asc(roundOffDates.date));
  return rows.map((r) => r.date);
};

/** Idempotent — adding an existing date is a no-op. */
export const addRoundOffDate = async (db: AnyPgDatabase, dateIso: string): Promise<void> => {
  await db.insert(roundOffDates).values({ date: dateIso }).onConflictDoNothing();
};

export const removeRoundOffDate = async (db: AnyPgDatabase, dateIso: string): Promise<void> => {
  await db.delete(roundOffDates).where(eq(roundOffDates.date, dateIso));
};

export const isRoundOffDate = async (db: AnyPgDatabase, dateIso: string): Promise<boolean> => {
  const rows = await db
    .select({ date: roundOffDates.date })
    .from(roundOffDates)
    .where(eq(roundOffDates.date, dateIso))
    .limit(1);
  return rows.length > 0;
};

// ---------------------------------------------------------------------------
// Customer personal area — my round bookings (super-brief §11.3)
// ---------------------------------------------------------------------------

export interface CustomerRoundBooking {
  bookingId: string;
  /** The round_instance this booking currently sits on (for the swap picker). */
  roundInstanceId: string;
  label: string;
  /** YYYY-MM-DD */
  date: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  status: 'confirmed' | 'used';
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  /** How it was paid for — drives the cancel copy (money refund vs punch return). */
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  /** The scannable barcode. Always present for confirmed/used bookings. */
  barcodeToken: string | null;
  /**
   * A companion checkout was started but not paid yet (punchcard booking with
   * a stamped wc_order_id and additional_companions still 0). The UI shows a
   * "complete payment" retry.
   */
  companionPending: boolean;
}

/**
 * A customer's active/upcoming round bookings + barcode (super-brief §11.3).
 * Confirmed or used bookings on today or a future date, chronological. Held /
 * expired / cancelled are never shown. Owner-scoped by customerId.
 */
export const listCustomerRoundBookings = async (
  db: AnyPgDatabase,
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerRoundBooking[]> => {
  const todayIso = toIsoDate(now);
  const rows = await db
    .select({
      bookingId: bookings.id,
      roundInstanceId: bookings.roundInstanceId,
      label: rounds.displayName,
      date: roundInstances.date,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
      status: bookings.status,
      ticketType: bookings.ticketType,
      additionalCompanions: bookings.additionalCompanions,
      source: bookings.source,
      barcodeToken: bookings.barcodeToken,
      wcOrderId: bookings.wcOrderId,
    })
    .from(bookings)
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(
      and(
        eq(bookings.customerId, customerId),
        sql`${bookings.status} IN ('confirmed','used')`,
        gte(roundInstances.date, todayIso),
      ),
    );

  return rows
    .map((r) => ({
      bookingId: r.bookingId,
      roundInstanceId: r.roundInstanceId,
      label: r.label,
      date: r.date,
      startTime: hhmm(r.startTime),
      endTime: hhmm(r.endTime),
      status: r.status as 'confirmed' | 'used',
      ticketType: r.ticketType,
      additionalCompanions: r.additionalCompanions,
      source: r.source,
      barcodeToken: r.barcodeToken,
      companionPending:
        r.source === 'punchcard' && r.wcOrderId !== null && r.additionalCompanions === 0,
    }))
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
};

// ---------------------------------------------------------------------------
// Instance materialization
// ---------------------------------------------------------------------------

/**
 * Ensure `round_instances` exist for `round` on every matching weekday in
 * [today, today+horizon). Idempotent — relies on the (round_id, date) unique
 * index, so re-running never duplicates and never overwrites an existing
 * instance (per-date overrides survive). A non-active round is a no-op.
 */
export const ensureUpcomingInstances = async (
  db: AnyPgDatabase,
  round: Round,
  now: Date = new Date(),
  horizonDays: number = INSTANCE_HORIZON_DAYS,
): Promise<void> => {
  if (!round.isActive) return;
  const base = startOfDay(now);
  const values: NewRoundInstance[] = [];
  for (let i = 0; i < horizonDays; i += 1) {
    const d = addDays(base, i);
    // daysActive bit 0 = Sunday … matches Date.getDay().
    if ((round.daysActive & (1 << d.getDay())) === 0) continue;
    values.push({ roundId: round.id, date: toIsoDate(d), capacity: round.defaultCapacity });
  }
  if (values.length === 0) return;
  await db
    .insert(roundInstances)
    .values(values)
    .onConflictDoNothing({ target: [roundInstances.roundId, roundInstances.date] });
};

/** Top up instances for every active round — used by the admin list read so
 *  the rolling window stays fresh without a separate job. */
export const ensureAllActiveInstances = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
  horizonDays: number = INSTANCE_HORIZON_DAYS,
): Promise<void> => {
  const active = await db.select().from(rounds).where(eq(rounds.isActive, true));
  for (const round of active) {
    await ensureUpcomingInstances(db, round, now, horizonDays);
  }
};

/** Count of materialized instances per round in [today, today+horizon) — a
 *  small summary for the admin list ("N upcoming dates"). */
export const countUpcomingInstances = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
  horizonDays: number = INSTANCE_HORIZON_DAYS,
): Promise<Map<string, number>> => {
  const base = startOfDay(now);
  const from = toIsoDate(base);
  const to = toIsoDate(addDays(base, horizonDays - 1));
  const rows = await db
    .select({ roundId: roundInstances.roundId, date: roundInstances.date })
    .from(roundInstances)
    .where(and(gte(roundInstances.date, from), lte(roundInstances.date, to)));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.roundId, (counts.get(r.roundId) ?? 0) + 1);
  return counts;
};

// ---------------------------------------------------------------------------
// Local date helpers (mirrors rounds-dashboard.ts; kept private per file).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function toIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Postgres TIME 'HH:MM:SS' → 'HH:MM' for display + comparison. */
function hhmm(t: string): string {
  return t.slice(0, 5);
}
