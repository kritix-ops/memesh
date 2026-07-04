// Real DB queries that back the /admin/dashboard/live endpoint (step 2b of
// admin-rounds-dashboard plan). Reads only — no writes. Sequential queries
// because PGlite (test fixture) is single-connection; pooled prod driver
// handles serial calls fine too. Pattern matches packages/db/src/reports.ts.
//
// Revenue is intentionally deferred — no price-at-sale is stored on bookings
// (same caveat as revenueReport), so dashboardLiveStats() returns
// revenueIls=0 / revenueDeltaPct=null until step 3 wires the pricing
// settings. The fields stay in the response shape so the SPA contract
// doesn't change.
//
// Alerts are intentionally deferred too — the payment_received_no_slot
// status isn't in the booking_status enum yet, and the "stuck hold" /
// "round full + growing waitlist" cases need application-level detection
// that hasn't been written. dashboardLiveAlerts() returns [] today; UI
// already hides the zone on empty.

import { and, count, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getCardSettings } from './card-settings';
import { addIsoDays, venueStartOfDay, venueTodayIso } from './round-time';
import {
  bookings,
  punchCards,
  roundInstances,
  rounds,
  waitlistEntries,
} from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Add days to a date, returning a new Date. */
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

// ---------------------------------------------------------------------------
// Today's rounds — per-round occupancy for the dashboard hero zone
// ---------------------------------------------------------------------------

export interface RoundsTodayRow {
  roundInstanceId: string;
  label: string;
  /** "HH:MM" — local time, used for display + sort. */
  startTime: string;
  endTime: string;
  capacity: number;
  /** confirmed + used + active holds */
  taken: number;
  /** Just the active-hold portion of `taken`. */
  heldCount: number;
  /** Real bookings: confirmed + used (holds excluded). */
  bookedCount: number;
  /** Checked in at the door (status = used) — "כמה הגיעו" (Yanay 2026-07-04). */
  arrivedCount: number;
  /** 0..100, rounded. */
  pctFull: number;
  isClosed: boolean;
}

/**
 * All round_instances for today (the venue date, Asia/Jerusalem), joined with
 * their parent round template for display data, with live occupancy counts.
 * Sorted by startTime ASC.
 *
 * Occupancy includes confirmed + used + active holds. Held bookings whose
 * hold_expires_at has passed are treated as released (the lazy-expiry
 * pattern from super-brief §3.3, in case the cleanup job hasn't fired yet).
 */
export const dashboardLiveRoundsToday = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
): Promise<RoundsTodayRow[]> => {
  return dashboardLiveRoundsForDate(db, venueTodayIso(now), now);
};

/**
 * Same per-round occupancy, for any calendar date — the staff panel's date
 * navigation reads future days so a cashier can verify a fresh booking landed
 * (Yanay 2026-07-04). `now` still controls hold-expiry math.
 */
export const dashboardLiveRoundsForDate = async (
  db: AnyPgDatabase,
  dateIso: string,
  now: Date = new Date(),
): Promise<RoundsTodayRow[]> => {
  // Round instances for the date + parent round template.
  const instances = await db
    .select({
      id: roundInstances.id,
      capacity: roundInstances.capacity,
      isClosed: roundInstances.isClosed,
      label: rounds.displayName,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
      sortOrder: rounds.sortOrder,
    })
    .from(roundInstances)
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(eq(roundInstances.date, dateIso));

  if (instances.length === 0) return [];

  // Per-instance counts — sequential to keep PGlite happy. One grouped query
  // per instance: filtered counts for holds / real bookings / door check-ins.
  const result: RoundsTodayRow[] = [];
  for (const inst of instances) {
    const countRows = await db
      .select({
        held: sql<string>`count(*) FILTER (WHERE ${bookings.status} = 'held' AND ${bookings.holdExpiresAt} > ${now})`,
        booked: sql<string>`count(*) FILTER (WHERE ${bookings.status} IN ('confirmed','used'))`,
        arrived: sql<string>`count(*) FILTER (WHERE ${bookings.status} = 'used')`,
      })
      .from(bookings)
      .where(eq(bookings.roundInstanceId, inst.id));
    const heldCount = Number(countRows[0]?.held ?? 0);
    const bookedCount = Number(countRows[0]?.booked ?? 0);
    const arrivedCount = Number(countRows[0]?.arrived ?? 0);
    const taken = heldCount + bookedCount;

    const pctFull = inst.capacity === 0 ? 0 : Math.round((taken / inst.capacity) * 100);

    result.push({
      roundInstanceId: inst.id,
      label: inst.label,
      startTime: hhmm(inst.startTime),
      endTime: hhmm(inst.endTime),
      capacity: inst.capacity,
      taken,
      heldCount,
      bookedCount,
      arrivedCount,
      pctFull,
      isClosed: inst.isClosed,
    });
  }

  // Sort by parent round.sortOrder, then startTime.
  result.sort((a, b) => a.startTime.localeCompare(b.startTime));

  return result;
};

/** Postgres TIME → "HH:MM" (drop the seconds). */
function hhmm(t: string): string {
  // Postgres returns 'HH:MM:SS'; we want display 'HH:MM'.
  return t.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Stats — today numbers with day-over-day deltas
// ---------------------------------------------------------------------------

export interface DashboardLiveStatsResult {
  revenueIls: number;
  /** null when revenue isn't computed (today) or yesterday's data point is missing. */
  revenueDeltaPct: number | null;
  bookingsCount: number;
  bookingsDelta: number | null;
  activeHoldsCount: number;
  punchCardsSold: number;
  punchCardsDelta: number | null;
  /** Paid additional companions on today's confirmed bookings (Yanay 2026-07-01). */
  companionsCount: number;
  companionsDelta: number | null;
}

/**
 * "Today's numbers" block. Bookings = confirmed today (excludes held in-flight
 * and failed paths). Day-over-day delta compares against the same hour
 * yesterday, so 11am today vs 11am yesterday — fair comparison through the day.
 *
 * Revenue (step 3b): computed from booking counts × current settings prices +
 * punch card counts × card price. Same honest caveat as revenueReport — real
 * price-at-sale isn't stored, so historical bookings that predate a price
 * change get multiplied by the current price. Displayed value is an estimate.
 */
export const dashboardLiveStats = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
): Promise<DashboardLiveStatsResult> => {
  const todayStart = venueStartOfDay(now);
  const yesterdayStart = addDays(todayStart, -1);

  // Read pricing once — used for both today's revenue and yesterday's baseline.
  const settings = await getCardSettings(db);
  const prices = {
    baby: settings.roundChildBabyPriceIls,
    over: settings.roundChildOverWalkingPriceIls,
    companion: settings.roundAdditionalCompanionPriceIls,
    punchCard: settings.priceShekels,
  };

  // Bookings confirmed today vs same hour yesterday.
  const bookingsToday = await countConfirmedBookingsInRange(db, todayStart, now);
  const bookingsYesterdayAtHour = await countConfirmedBookingsInRange(
    db,
    yesterdayStart,
    addDays(now, -1),
  );
  const bookingsDelta = bookingsYesterdayAtHour === 0 ? null : bookingsToday - bookingsYesterdayAtHour;

  // Active holds — status='held' AND hold_expires_at > now()
  const activeHoldsRows = await db
    .select({ n: count() })
    .from(bookings)
    .where(and(eq(bookings.status, 'held'), gte(bookings.holdExpiresAt, now)));
  const activeHoldsCount = Number(activeHoldsRows[0]?.n ?? 0);

  // Punch cards sold today vs same hour yesterday. Cancelled cards excluded
  // (matches the revenueReport convention).
  const cardsToday = await countPunchCardsInRange(db, todayStart, now);
  const cardsYesterdayAtHour = await countPunchCardsInRange(
    db,
    yesterdayStart,
    addDays(now, -1),
  );
  const punchCardsDelta = cardsYesterdayAtHour === 0 ? null : cardsToday - cardsYesterdayAtHour;

  // Paid additional companions today vs same hour yesterday.
  const companionsToday = await sumCompanionsInRange(db, todayStart, now);
  const companionsYesterdayAtHour = await sumCompanionsInRange(
    db,
    yesterdayStart,
    addDays(now, -1),
  );
  const companionsDelta =
    companionsYesterdayAtHour === 0 ? null : companionsToday - companionsYesterdayAtHour;

  // Revenue = paid/gift bookings today × their prices + punch cards × price.
  // Bookings with source='punchcard' don't count (they were pre-paid) and
  // source='manual' doesn't count (comped).
  const revenueToday = await computeRevenueForRange(db, todayStart, now, prices);
  const revenueYesterdayAtHour = await computeRevenueForRange(
    db,
    yesterdayStart,
    addDays(now, -1),
    prices,
  );
  const revenueDeltaPct =
    revenueYesterdayAtHour === 0
      ? null
      : Math.round(((revenueToday - revenueYesterdayAtHour) / revenueYesterdayAtHour) * 100);

  return {
    revenueIls: revenueToday,
    revenueDeltaPct,
    bookingsCount: bookingsToday,
    bookingsDelta,
    activeHoldsCount,
    punchCardsSold: cardsToday,
    punchCardsDelta,
    companionsCount: companionsToday,
    companionsDelta,
  };
};

type RoundPrices = {
  baby: number;
  over: number;
  companion: number;
  punchCard: number;
};

/**
 * Sum revenue for [start, end): (paid + gift) bookings × ticket-type price +
 * additional_companions × companion price + uncancelled punch cards × card
 * price. Source-filter matches revenueReport's honesty convention.
 */
async function computeRevenueForRange(
  db: AnyPgDatabase,
  start: Date,
  end: Date,
  prices: RoundPrices,
): Promise<number> {
  // Bookings: sum by ticket_type + additional_companions.
  const bookingRows = await db
    .select({
      ticketType: bookings.ticketType,
      additionalCompanions: bookings.additionalCompanions,
    })
    .from(bookings)
    .where(
      and(
        sql`${bookings.status} IN ('confirmed','used')`,
        sql`${bookings.source} IN ('paid','gift')`,
        gte(bookings.confirmedAt, start),
        lt(bookings.confirmedAt, end),
      ),
    );

  let bookingsRevenue = 0;
  for (const row of bookingRows) {
    const ticketPrice = row.ticketType === 'child_under_walking' ? prices.baby : prices.over;
    bookingsRevenue += ticketPrice + row.additionalCompanions * prices.companion;
  }

  // Punch cards: count × card price.
  const punchCardCount = await countPunchCardsInRange(db, start, end);
  const punchCardRevenue = punchCardCount * prices.punchCard;

  return bookingsRevenue + punchCardRevenue;
}

/** Bookings with status IN (confirmed, used) and confirmed_at in [start, end). */
async function countConfirmedBookingsInRange(
  db: AnyPgDatabase,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(bookings)
    .where(
      and(
        sql`${bookings.status} IN ('confirmed','used')`,
        gte(bookings.confirmedAt, start),
        lt(bookings.confirmedAt, end),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Sum of additional_companions over bookings with status IN (confirmed, used),
 * source IN (paid, gift), and confirmed_at in [start, end). Source filter
 * matches computeRevenueForRange — these are the companions that were sold,
 * not comped ones.
 */
async function sumCompanionsInRange(
  db: AnyPgDatabase,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`COALESCE(SUM(${bookings.additionalCompanions}), 0)` })
    .from(bookings)
    .where(
      and(
        sql`${bookings.status} IN ('confirmed','used')`,
        sql`${bookings.source} IN ('paid','gift')`,
        gte(bookings.confirmedAt, start),
        lt(bookings.confirmedAt, end),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** Punch cards created in [start, end), excluding cancelled. */
async function countPunchCardsInRange(
  db: AnyPgDatabase,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(punchCards)
    .where(
      and(
        gte(punchCards.createdAt, start),
        lt(punchCards.createdAt, end),
        sql`${punchCards.cancelledAt} IS NULL`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Waitlist activity — live counts per round_instance with waiting entries
// ---------------------------------------------------------------------------

export interface WaitlistActivityRow {
  roundInstanceId: string;
  label: string;
  waitingCount: number;
  lastNotifiedAt: string | null;
}

/**
 * One row per round_instance today with at least one entry in status='waiting'
 * or 'notified'. Sorted by waitingCount DESC (busier rounds first).
 */
export const dashboardLiveWaitlist = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
): Promise<WaitlistActivityRow[]> => {
  const todayIso = venueTodayIso(now);

  // Get today's round_instances first.
  const todayInstances = await db
    .select({ id: roundInstances.id, label: rounds.displayName, startTime: rounds.startTime })
    .from(roundInstances)
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .where(eq(roundInstances.date, todayIso));

  if (todayInstances.length === 0) return [];

  const result: WaitlistActivityRow[] = [];
  for (const inst of todayInstances) {
    const waitingRows = await db
      .select({ n: count() })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.roundInstanceId, inst.id),
          sql`${waitlistEntries.status} IN ('waiting','notified')`,
        ),
      );
    const waitingCount = Number(waitingRows[0]?.n ?? 0);
    if (waitingCount === 0) continue;

    // PostgreSQL's `ORDER BY ... DESC` defaults to NULLS FIRST, so we filter
    // out rows that were never notified before picking the most recent one.
    // (The alternative — DESC NULLS LAST — is Drizzle-clunky to express;
    // filtering is also a touch cheaper since the index won't include nulls.)
    const lastNotifiedRows = await db
      .select({ notifiedAt: waitlistEntries.notifiedAt })
      .from(waitlistEntries)
      .where(
        and(eq(waitlistEntries.roundInstanceId, inst.id), isNotNull(waitlistEntries.notifiedAt)),
      )
      .orderBy(desc(waitlistEntries.notifiedAt))
      .limit(1);
    const lastNotifiedAt = lastNotifiedRows[0]?.notifiedAt ?? null;

    result.push({
      roundInstanceId: inst.id,
      label: `${inst.label} ${hhmm(inst.startTime)}`,
      waitingCount,
      lastNotifiedAt:
        lastNotifiedAt instanceof Date ? lastNotifiedAt.toISOString() : (lastNotifiedAt as string | null),
    });
  }

  // Busier waitlists first.
  result.sort((a, b) => b.waitingCount - a.waitingCount);

  return result;
};

// ---------------------------------------------------------------------------
// Week-ahead grid — 7 days × all active rounds, with per-cell occupancy
// ---------------------------------------------------------------------------

export interface WeekAheadCellRow {
  /** null when this round doesn't run on this date (e.g., Friday off). */
  roundInstanceId: string | null;
  label: string;
  /** "HH:MM" */
  startTime: string;
  /** null when roundInstanceId is null. */
  pctFull: number | null;
  isClosed: boolean;
}

export interface WeekAheadDayRow {
  /** YYYY-MM-DD */
  date: string;
  rounds: WeekAheadCellRow[];
}

/**
 * 7-day forward grid starting from today. Every active round template
 * appears every day; days without a materialized round_instance get
 * roundInstanceId=null and pctFull=null (rendered as "סגור" in the UI).
 * Matches the contract decided in the dashboard plan.
 */
export const dashboardLiveWeekAhead = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
  days = 7,
): Promise<WeekAheadDayRow[]> => {
  // Active templates that we'll project across the 7 days. Sorted by
  // sort_order then start_time so cells line up consistently.
  const activeTemplates = await db
    .select({
      id: rounds.id,
      label: rounds.displayName,
      startTime: rounds.startTime,
      sortOrder: rounds.sortOrder,
    })
    .from(rounds)
    .where(eq(rounds.isActive, true));
  activeTemplates.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.startTime.localeCompare(b.startTime);
  });

  // Date range we care about (venue dates). Inclusive of today, exclusive of
  // today+days.
  const todayIso = venueTodayIso(now);
  const dateList: string[] = [];
  for (let i = 0; i < days; i += 1) {
    dateList.push(addIsoDays(todayIso, i));
  }

  // All round_instances in the date range, keyed by (date, round_id). One
  // query then bucket in memory — avoids days*templates queries.
  const rangeStart = dateList[0]!;
  const rangeEnd = dateList[dateList.length - 1]!;
  const instances = await db
    .select({
      id: roundInstances.id,
      roundId: roundInstances.roundId,
      date: roundInstances.date,
      capacity: roundInstances.capacity,
      isClosed: roundInstances.isClosed,
    })
    .from(roundInstances)
    .where(
      and(
        gte(roundInstances.date, rangeStart),
        sql`${roundInstances.date} <= ${rangeEnd}`,
      ),
    );

  const instanceKey = (date: string, roundId: string) => `${date}::${roundId}`;
  const instanceByKey = new Map(instances.map((i) => [instanceKey(i.date, i.roundId), i]));

  // Per-instance taken count — one query per instance, sequential.
  const takenByInstanceId = new Map<string, number>();
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
    takenByInstanceId.set(inst.id, Number(takenRows[0]?.n ?? 0));
  }

  // Build the grid.
  return dateList.map((date) => ({
    date,
    rounds: activeTemplates.map((tpl) => {
      const inst = instanceByKey.get(instanceKey(date, tpl.id));
      if (!inst) {
        return {
          roundInstanceId: null,
          label: tpl.label,
          startTime: hhmm(tpl.startTime),
          pctFull: null,
          isClosed: false,
        };
      }
      const taken = takenByInstanceId.get(inst.id) ?? 0;
      const pctFull = inst.capacity === 0 ? 0 : Math.round((taken / inst.capacity) * 100);
      return {
        roundInstanceId: inst.id,
        label: tpl.label,
        startTime: hhmm(tpl.startTime),
        pctFull,
        isClosed: inst.isClosed,
      };
    }),
  }));
};
