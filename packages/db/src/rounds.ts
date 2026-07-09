// Admin CRUD for round templates + idempotent materialization of their
// per-date `round_instances`. The dashboard reads round_instances, so creating
// a template alone shows nothing — every write path here also ensures the
// upcoming instances exist. Pattern mirrors card-settings/dashboard-settings:
// pure validation, then persist; helpers return a discriminated result.

import { and, asc, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { addIsoDays, isRoundEnded, isoWeekday, venueTodayIso } from './round-time';
import {
  bookings,
  customers,
  roundInstances,
  roundReminderLog,
  rounds,
  waitlistEntries,
  type NewRoundInstance,
  type Round,
} from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

// Rolling window of days for which instances are kept materialized — the
// booking window customers can reach (Yanay 2026-07-05: "a month and a year
// ahead, otherwise they nag us all day"). The daily top-up cron
// (/cron/rounds-instances-topup) keeps it rolling; the on-view top-up in the
// admin list read stays as a fallback.
export const INSTANCE_HORIZON_DAYS = 365;

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

/** What a template edit did to the round's future instances — returned to the
 *  admin UI so nothing about the sweep is silent. */
export type RoundPropagation = {
  /** Future instances whose capacity followed the template edit. */
  capacityUpdated: number;
  /** Future dates that kept their old capacity because seats are taken there. */
  capacityKeptDates: string[];
  /** Future instances deleted because their weekday left daysActive. */
  instancesRemoved: number;
  /** Future dates on removed weekdays kept because bookings anchor them. */
  removedDayKeptDates: string[];
};

export type UpdateRoundResult =
  | { ok: true; round: Round; propagation: RoundPropagation }
  | { ok: false; error: RoundValidationError }
  | { ok: false; notFound: true };

/** Edit a round template (partial). Propagates capacity/weekday changes to
 *  the round's future instances (see propagateRoundTemplateChange), then
 *  re-materializes so a newly-added weekday or a re-activation starts
 *  appearing immediately. */
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
  const propagation = await propagateRoundTemplateChange(db, current, round, now);
  await ensureUpcomingInstances(db, round, now);
  return { ok: true, round, propagation };
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
  // A round whose hours are already over today isn't bookable (Yanay
  // 2026-07-07) — drop it so the swap round list and single-date picker never
  // offer a passed slot. Today only; a future date has no ended rounds.
  if (dateIso === venueTodayIso(now)) {
    return result.filter((r) => !isRoundEnded(dateIso, r.endTime, now));
  }
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

// Per-date / recurring schedule rules (windows, free-play vs closed) live in
// rounds-schedule.ts — they replaced the short-lived off-dates helpers.

// ---------------------------------------------------------------------------
// Customer personal area — my round bookings (super-brief §11.3)
// ---------------------------------------------------------------------------

export interface CustomerRoundBooking {
  bookingId: string;
  /** Human-friendly ticket number (R-YYYYMMDD-NNNN) — the manual door fallback. */
  bookingNumber: string | null;
  /** The round_instance this booking currently sits on (for the swap picker). */
  roundInstanceId: string;
  /** The punch card this booking was made from (source='punchcard'), else null
   *  — lets the cards screen badge a card with its upcoming reservation. */
  punchCardId: string | null;
  label: string;
  /** YYYY-MM-DD */
  date: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  status: 'confirmed' | 'used' | 'cancelled';
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  /** How it was paid for — drives the cancel copy (money refund vs punch return). */
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  /** The scannable barcode. Present for confirmed/used; null once cancelled. */
  barcodeToken: string | null;
  /**
   * A companion checkout was started but not paid yet (punchcard booking with
   * a stamped wc_order_id and additional_companions still 0). The UI shows a
   * "complete payment" retry.
   */
  companionPending: boolean;
}

/** Which slice of a customer's bookings to return (customer-area filters,
 *  Yanay 2026-07-08). Default 'upcoming' preserves the §11.3 personal-area view. */
export type CustomerBookingScope = 'upcoming' | 'past' | 'cancelled' | 'all';

export interface ListCustomerBookingsOpts {
  scope?: CustomerBookingScope;
  /** Lower date bound (YYYY-MM-DD) for the period chips — e.g. last 3 months. */
  sinceIso?: string | null;
}

/**
 * A customer's round bookings + barcode (super-brief §11.3), sliced by `scope`:
 *   - upcoming (default): confirmed/used on today or later — the active view.
 *   - past: confirmed/used before today — attendance history.
 *   - cancelled: cancelled bookings.
 *   - all: any of the above (a cancelled booking with a future date included).
 * `sinceIso` further bounds the date from below (period filter). Owner-scoped.
 * Upcoming sorts soonest-first; the history scopes sort most-recent-first.
 */
export const listCustomerRoundBookings = async (
  db: AnyPgDatabase,
  customerId: string,
  opts: ListCustomerBookingsOpts = {},
  now: Date = new Date(),
): Promise<CustomerRoundBooking[]> => {
  const scope = opts.scope ?? 'upcoming';
  const todayIso = venueTodayIso(now);

  const conds = [eq(bookings.customerId, customerId)];
  if (scope === 'upcoming') {
    conds.push(sql`${bookings.status} IN ('confirmed','used')`);
    conds.push(gte(roundInstances.date, todayIso));
  } else if (scope === 'past') {
    conds.push(sql`${bookings.status} IN ('confirmed','used')`);
    conds.push(sql`${roundInstances.date} < ${todayIso}`);
  } else if (scope === 'cancelled') {
    conds.push(eq(bookings.status, 'cancelled'));
  } else {
    conds.push(sql`${bookings.status} IN ('confirmed','used','cancelled')`);
  }
  if (opts.sinceIso) conds.push(gte(roundInstances.date, opts.sinceIso));

  const rows = await db
    .select({
      bookingId: bookings.id,
      bookingNumber: bookings.bookingNumber,
      roundInstanceId: bookings.roundInstanceId,
      punchCardId: bookings.punchCardId,
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
    .where(and(...conds));

  const dir = scope === 'upcoming' ? 1 : -1; // history reads newest-first
  return rows
    .map((r) => ({
      bookingId: r.bookingId,
      bookingNumber: r.bookingNumber,
      roundInstanceId: r.roundInstanceId,
      punchCardId: r.punchCardId,
      label: r.label,
      date: r.date,
      startTime: hhmm(r.startTime),
      endTime: hhmm(r.endTime),
      status: r.status as 'confirmed' | 'used' | 'cancelled',
      ticketType: r.ticketType,
      additionalCompanions: r.additionalCompanions,
      source: r.source,
      barcodeToken: r.barcodeToken,
      companionPending:
        r.source === 'punchcard' && r.wcOrderId !== null && r.additionalCompanions === 0,
    }))
    .sort((a, b) => dir * `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
};

// ---------------------------------------------------------------------------
// Shift floor — who's booked on a round and who already arrived
// ---------------------------------------------------------------------------

export interface RoundAttendee {
  bookingId: string;
  /** Human-friendly ticket number — lets the floor cross-check a spoken number. */
  bookingNumber: string | null;
  firstName: string;
  lastName: string;
  /** Contact details for the floor (Yanay explicitly asked for them, 2026-07-04). */
  phone: string;
  email: string | null;
  ticketType: 'child_under_walking' | 'child_over_walking';
  additionalCompanions: number;
  /** Payment origin. `manual` = a staff walk-in add — shown separately from
   *  the ones who registered (Yanay 2026-07-07). */
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
  /** Checked in at the door (booking burned to 'used'). */
  arrived: boolean;
  /** ISO timestamp of the door scan; null until arrival. */
  usedAt: string | null;
}

/**
 * The booked customers of one round instance with arrival status + contact
 * details, for the staff panel's "מי הגיע" list (Yanay 2026-07-04) — e.g.
 * calling a no-show ten minutes into the round. Arrived first (newest scan
 * first), then waiting by name.
 */
export const listRoundAttendees = async (
  db: AnyPgDatabase,
  roundInstanceId: string,
): Promise<RoundAttendee[]> => {
  const rows = await db
    .select({
      bookingId: bookings.id,
      bookingNumber: bookings.bookingNumber,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      email: customers.email,
      ticketType: bookings.ticketType,
      additionalCompanions: bookings.additionalCompanions,
      source: bookings.source,
      status: bookings.status,
      usedAt: bookings.usedAt,
    })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(
      and(
        eq(bookings.roundInstanceId, roundInstanceId),
        sql`${bookings.status} IN ('confirmed','used')`,
      ),
    );

  return rows
    .map((r) => ({
      bookingId: r.bookingId,
      bookingNumber: r.bookingNumber,
      firstName: r.firstName,
      lastName: r.lastName,
      phone: r.phone,
      email: r.email,
      ticketType: r.ticketType as 'child_under_walking' | 'child_over_walking',
      additionalCompanions: r.additionalCompanions,
      source: r.source as 'paid' | 'punchcard' | 'gift' | 'manual',
      arrived: r.status === 'used',
      usedAt: r.usedAt ? r.usedAt.toISOString() : null,
    }))
    .sort((a, b) => {
      if (a.arrived !== b.arrived) return a.arrived ? -1 : 1;
      if (a.arrived && a.usedAt && b.usedAt) return b.usedAt.localeCompare(a.usedAt);
      return `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, 'he');
    });
};

export interface UpcomingReservation {
  bookingId: string;
  roundInstanceId: string;
  label: string;
  /** YYYY-MM-DD */
  date: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  source: 'paid' | 'punchcard' | 'gift' | 'manual';
}

/**
 * A customer's confirmed reservations on venue-today or later — the "you
 * already have an entrance booked" signal (Yanay 2026-07-07). A punch-card
 * reservation spent its entry at booking time, so surfacing these at the door
 * and in the personal area stops anyone from thinking an entry vanished, or
 * from burning a card down before a reserved date. Confirmed only (a `used`
 * booking already walked in); soonest first.
 */
export const listUpcomingReservationsForCustomer = async (
  db: AnyPgDatabase,
  customerId: string,
  now: Date = new Date(),
): Promise<UpcomingReservation[]> => {
  const todayIso = venueTodayIso(now);
  const rows = await db
    .select({
      bookingId: bookings.id,
      roundInstanceId: bookings.roundInstanceId,
      label: rounds.displayName,
      date: roundInstances.date,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
      source: bookings.source,
    })
    .from(bookings)
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(
      and(
        eq(bookings.customerId, customerId),
        eq(bookings.status, 'confirmed'),
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
      source: r.source as 'paid' | 'punchcard' | 'gift' | 'manual',
    }))
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
};

// ---------------------------------------------------------------------------
// Instance materialization
// ---------------------------------------------------------------------------

/**
 * Push a template edit out to the round's future instances, deterministically
 * (plan 2026-07-05-booking-window-365): with the horizon at a full year,
 * "existing instances are never touched" would freeze a capacity edit out of
 * the whole booking window.
 *   - defaultCapacity change → every instance from venue-today on takes the
 *     new capacity, EXCEPT dates the admin set by hand (capacity_overridden)
 *     and dates where seats are already taken — changing those is a human
 *     decision, so they come back in the report instead.
 *   - weekday removed from daysActive → its future instances are deleted,
 *     EXCEPT dates any booking ever touched (bookings are the audit trail,
 *     same stance as deleteRound) — those also come back in the report.
 * Weekday additions and reactivation are ensureUpcomingInstances' job, and
 * label/time edits live on the template, so they propagate by themselves.
 */
export const propagateRoundTemplateChange = async (
  db: AnyPgDatabase,
  before: Round,
  after: Round,
  now: Date = new Date(),
): Promise<RoundPropagation> => {
  const todayIso = venueTodayIso(now);
  const result: RoundPropagation = {
    capacityUpdated: 0,
    capacityKeptDates: [],
    instancesRemoved: 0,
    removedDayKeptDates: [],
  };

  // Same seats-taken predicate as availability: confirmed + used + unexpired
  // holds. A date with only cancelled/expired bookings has no seats to
  // protect, so it follows the template like any empty date.
  const seatsTaken = sql`EXISTS (
    SELECT 1 FROM ${bookings}
    WHERE ${bookings.roundInstanceId} = ${roundInstances.id}
      AND (${bookings.status} IN ('confirmed','used')
        OR (${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now}))
  )`;

  if (after.defaultCapacity !== before.defaultCapacity) {
    const kept = await db
      .select({ date: roundInstances.date })
      .from(roundInstances)
      .where(
        and(
          eq(roundInstances.roundId, after.id),
          gte(roundInstances.date, todayIso),
          eq(roundInstances.capacityOverridden, false),
          sql`${roundInstances.capacity} <> ${after.defaultCapacity}`,
          seatsTaken,
        ),
      );
    result.capacityKeptDates = kept.map((r) => r.date).sort();

    const updatedRows = await db
      .update(roundInstances)
      .set({ capacity: after.defaultCapacity, updatedAt: now })
      .where(
        and(
          eq(roundInstances.roundId, after.id),
          gte(roundInstances.date, todayIso),
          eq(roundInstances.capacityOverridden, false),
          sql`NOT (${seatsTaken})`,
        ),
      )
      .returning({ id: roundInstances.id });
    result.capacityUpdated = updatedRows.length;
  }

  const removedMask = before.daysActive & ~after.daysActive;
  if (removedMask !== 0) {
    const future = await db
      .select({ id: roundInstances.id, date: roundInstances.date })
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, after.id), gte(roundInstances.date, todayIso)));
    const onRemovedDays = future.filter((r) => (removedMask & (1 << isoWeekday(r.date))) !== 0);
    if (onRemovedDays.length > 0) {
      const ids = onRemovedDays.map((r) => r.id);
      // Any booking row (any status) anchors history to its instance — the FK
      // forbids deleting it anyway. Those dates survive, reported.
      const anchored = await db
        .select({ id: bookings.roundInstanceId })
        .from(bookings)
        .where(inArray(bookings.roundInstanceId, ids))
        .groupBy(bookings.roundInstanceId);
      const anchoredIds = new Set(anchored.map((r) => r.id));
      result.removedDayKeptDates = onRemovedDays
        .filter((r) => anchoredIds.has(r.id))
        .map((r) => r.date)
        .sort();

      const deletable = ids.filter((instId) => !anchoredIds.has(instId));
      if (deletable.length > 0) {
        await db
          .delete(roundReminderLog)
          .where(inArray(roundReminderLog.roundInstanceId, deletable));
        await db.delete(waitlistEntries).where(inArray(waitlistEntries.roundInstanceId, deletable));
        await db.delete(roundInstances).where(inArray(roundInstances.id, deletable));
        result.instancesRemoved = deletable.length;
      }
    }
  }

  return result;
};

/**
 * Ensure `round_instances` exist for `round` on every matching weekday in
 * [today, today+horizon), where "today" is the venue date (Asia/Jerusalem),
 * never the server's local date. Idempotent — relies on the (round_id, date)
 * unique index, so re-running never duplicates and never overwrites an
 * existing instance (per-date overrides survive). A non-active round is a
 * no-op. Returns how many instances were actually created.
 */
export const ensureUpcomingInstances = async (
  db: AnyPgDatabase,
  round: Round,
  now: Date = new Date(),
  horizonDays: number = INSTANCE_HORIZON_DAYS,
): Promise<number> => {
  if (!round.isActive) return 0;
  const todayIso = venueTodayIso(now);
  const values: NewRoundInstance[] = [];
  for (let i = 0; i < horizonDays; i += 1) {
    const dateIso = addIsoDays(todayIso, i);
    // daysActive bit 0 = Sunday … matches isoWeekday.
    if ((round.daysActive & (1 << isoWeekday(dateIso))) === 0) continue;
    values.push({ roundId: round.id, date: dateIso, capacity: round.defaultCapacity });
  }
  if (values.length === 0) return 0;
  const inserted = await db
    .insert(roundInstances)
    .values(values)
    .onConflictDoNothing({ target: [roundInstances.roundId, roundInstances.date] })
    .returning({ id: roundInstances.id });
  return inserted.length;
};

/** Top up instances for every active round — run daily by the top-up cron,
 *  and by the admin list read as a fallback so the window never depends on
 *  the cron alone. Returns how many instances were created in total. */
export const ensureAllActiveInstances = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
  horizonDays: number = INSTANCE_HORIZON_DAYS,
): Promise<number> => {
  const active = await db.select().from(rounds).where(eq(rounds.isActive, true));
  let created = 0;
  for (const round of active) {
    created += await ensureUpcomingInstances(db, round, now, horizonDays);
  }
  return created;
};

/** Count of materialized instances per round in [today, today+horizon) — a
 *  small summary for the admin list ("N upcoming dates"). */
export const countUpcomingInstances = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
  horizonDays: number = INSTANCE_HORIZON_DAYS,
): Promise<Map<string, number>> => {
  const from = venueTodayIso(now);
  const to = addIsoDays(from, horizonDays - 1);
  const rows = await db
    .select({ roundId: roundInstances.roundId, date: roundInstances.date })
    .from(roundInstances)
    .where(and(gte(roundInstances.date, from), lte(roundInstances.date, to)));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.roundId, (counts.get(r.roundId) ?? 0) + 1);
  return counts;
};

// ---------------------------------------------------------------------------
// Local helpers (date math lives in round-time.ts, venue timezone).
// ---------------------------------------------------------------------------

/** Postgres TIME 'HH:MM:SS' → 'HH:MM' for display + comparison. */
function hhmm(t: string): string {
  return t.slice(0, 5);
}
