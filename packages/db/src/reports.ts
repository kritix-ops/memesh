import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { alias, type PgDatabase } from 'drizzle-orm/pg-core';
import { getCustomerById } from './accounts';
import { getCardSettings } from './card-settings';
import {
  bookings,
  cardSettings,
  customers,
  punchCardEntries,
  punchCards,
  roundInstances,
  rounds,
  staff,
} from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);
const daysAhead = (now: Date, days: number) => new Date(now.getTime() + days * DAY_MS);

// Run counts sequentially: PGlite (used in tests) is single-connection and does
// not allow concurrent queries. A pooled prod driver handles this fine too.
const countRows = async (
  db: AnyPgDatabase,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  where: ReturnType<typeof gte>,
): Promise<number> => {
  const rows = await db.select({ n: count() }).from(table).where(where);
  return Number(rows[0]?.n ?? 0);
};

export interface DashboardStats {
  entriesLast24h: number;
  entriesLast7d: number;
  entriesLast30d: number;
  cardsSoldLast30d: number;
  expiringIn30d: number;
  newCustomersLast7d: number;
}

export const dashboardStats = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
): Promise<DashboardStats> => {
  const entriesLast24h = await countRows(
    db,
    punchCardEntries,
    gte(punchCardEntries.punchedAt, daysAgo(now, 1)),
  );
  const entriesLast7d = await countRows(
    db,
    punchCardEntries,
    gte(punchCardEntries.punchedAt, daysAgo(now, 7)),
  );
  const entriesLast30d = await countRows(
    db,
    punchCardEntries,
    gte(punchCardEntries.punchedAt, daysAgo(now, 30)),
  );
  const cardsSoldLast30d = await countRows(
    db,
    punchCards,
    gte(punchCards.createdAt, daysAgo(now, 30)),
  );
  const newCustomersLast7d = await countRows(
    db,
    customers,
    gte(customers.createdAt, daysAgo(now, 7)),
  );

  // Active cards expiring within the next 30 days.
  const expiringRows = await db
    .select({ n: count() })
    .from(punchCards)
    .where(
      and(
        eq(punchCards.isActive, true),
        gte(punchCards.expiresAt, now),
        lt(punchCards.expiresAt, daysAhead(now, 30)),
      ),
    );
  const expiringIn30d = Number(expiringRows[0]?.n ?? 0);

  return {
    entriesLast24h,
    entriesLast7d,
    entriesLast30d,
    cardsSoldLast30d,
    expiringIn30d,
    newCustomersLast7d,
  };
};

/** A customer plus their cards and recent entries, for the staff/admin detail view. */
export const customerDetail = async (db: AnyPgDatabase, id: string) => {
  const customer = await getCustomerById(db, id);
  if (!customer) return undefined;
  const cards = await db
    .select()
    .from(punchCards)
    .where(eq(punchCards.customerId, id))
    .orderBy(desc(punchCards.createdAt));
  const cardIds = cards.map((c) => c.id);
  const entries = cardIds.length
    ? await db
        .select()
        .from(punchCardEntries)
        .where(inArray(punchCardEntries.punchCardId, cardIds))
        .orderBy(desc(punchCardEntries.punchedAt))
        .limit(50)
    : [];
  return { customer, cards, entries };
};

export interface DormantCustomer {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  lastVisit: string | null;
}

/**
 * Customers who hold a card but have not visited in `days` days (or never).
 * These are the re-engagement / win-back list.
 */
export const dormantCustomers = async (
  db: AnyPgDatabase,
  now: Date = new Date(),
  days = 30,
): Promise<DormantCustomer[]> => {
  const threshold = daysAgo(now, days).getTime();
  const rows = await db
    .select({
      customerId: punchCards.customerId,
      lastEntry: sql<string | null>`max(${punchCardEntries.punchedAt})`,
    })
    .from(punchCards)
    .leftJoin(punchCardEntries, eq(punchCardEntries.punchCardId, punchCards.id))
    .groupBy(punchCards.customerId);

  const dormant = rows.filter((r) => {
    if (!r.lastEntry) return true;
    return new Date(r.lastEntry).getTime() < threshold;
  });

  const result: DormantCustomer[] = [];
  for (const d of dormant) {
    const c = await db
      .select({
        id: customers.id,
        customerNumber: customers.customerNumber,
        firstName: customers.firstName,
        lastName: customers.lastName,
        phone: customers.phone,
      })
      .from(customers)
      .where(eq(customers.id, d.customerId))
      .limit(1);
    const row = c[0];
    if (row) result.push({ ...row, lastVisit: d.lastEntry });
  }
  return result;
};

// ---------------------------------------------------------------------------
// Reports — rich filtered queries for the admin Reports surface.
//
// Each function takes a structured filter object and returns rows in the
// shape the API will pass through verbatim. Sorting where applicable.
// ---------------------------------------------------------------------------

const REPORT_DEFAULT_LIMIT = 200;
const REPORT_MAX_LIMIT = 1000;

export interface CustomersReportFilters {
  q?: string;
  registeredFrom?: Date;
  registeredTo?: Date;
  source?: 'referral' | 'social' | 'walk_by' | 'website' | 'other';
  marketingConsent?: boolean;
  hasActiveCard?: boolean;
  dormantSinceDays?: number;
  limit?: number;
  sort?: 'createdAt' | 'lastVisit' | 'customerNumber';
  sortDir?: 'asc' | 'desc';
}

export interface CustomersReportRow {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  source: string | null;
  marketingConsentAt: string | null;
  createdAt: string;
  lastVisit: string | null;
  activeCards: number;
  totalCards: number;
}

/**
 * Customers report. Builds a base customer query, then enriches each row
 * with active-card count and last-visit timestamp via subqueries. Filter
 * combinators are AND'd; q is a wide ILIKE across name + phone + number +
 * email.
 */
export const customersReport = async (
  db: AnyPgDatabase,
  filters: CustomersReportFilters = {},
  now: Date = new Date(),
): Promise<CustomersReportRow[]> => {
  const limit = Math.min(filters.limit ?? REPORT_DEFAULT_LIMIT, REPORT_MAX_LIMIT);
  const conds = [];
  const q = filters.q?.trim();
  if (q) {
    const p = `%${q}%`;
    const qC = or(
      ilike(customers.firstName, p),
      ilike(customers.lastName, p),
      ilike(customers.phone, p),
      ilike(customers.customerNumber, p),
      ilike(customers.email, p),
    );
    if (qC) conds.push(qC);
  }
  if (filters.registeredFrom) conds.push(gte(customers.createdAt, filters.registeredFrom));
  if (filters.registeredTo) conds.push(lte(customers.createdAt, filters.registeredTo));
  if (filters.source) conds.push(eq(customers.source, filters.source));
  if (filters.marketingConsent === true) conds.push(isNotNull(customers.marketingConsentAt));
  if (filters.marketingConsent === false) conds.push(isNull(customers.marketingConsentAt));

  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  // Sort SQL builder per column.
  const sortCol =
    filters.sort === 'customerNumber'
      ? customers.customerNumber
      : filters.sort === 'lastVisit'
        ? customers.createdAt // last-visit sort handled in JS below since it's a subquery
        : customers.createdAt;
  const sortFn = filters.sortDir === 'asc' ? asc : desc;

  let baseQuery = db
    .select({
      id: customers.id,
      customerNumber: customers.customerNumber,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      email: customers.email,
      source: customers.source,
      marketingConsentAt: customers.marketingConsentAt,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .$dynamic();
  if (where) baseQuery = baseQuery.where(where);
  const baseRows = await baseQuery.orderBy(sortFn(sortCol)).limit(limit);

  // Enrich each row with active-card count + last-visit. We do this in a
  // single follow-up query per metric, keyed by the customer ids we just
  // got, to avoid N+1.
  const ids = baseRows.map((r) => r.id);
  if (ids.length === 0) return [];

  const cardCountRows = await db
    .select({
      customerId: punchCards.customerId,
      total: sql<number>`cast(count(*) as int)`,
      active: sql<number>`cast(count(case when ${punchCards.isActive} then 1 end) as int)`,
    })
    .from(punchCards)
    .where(inArray(punchCards.customerId, ids))
    .groupBy(punchCards.customerId);
  const cardCounts = new Map(
    cardCountRows.map((r) => [r.customerId, { total: r.total, active: r.active }]),
  );

  const lastVisitRows = await db
    .select({
      customerId: punchCards.customerId,
      lastVisit: sql<string | null>`max(${punchCardEntries.punchedAt})`,
    })
    .from(punchCards)
    .leftJoin(punchCardEntries, eq(punchCardEntries.punchCardId, punchCards.id))
    .where(inArray(punchCards.customerId, ids))
    .groupBy(punchCards.customerId);
  const lastVisits = new Map(lastVisitRows.map((r) => [r.customerId, r.lastVisit]));

  let enriched: CustomersReportRow[] = baseRows.map((r) => {
    const cc = cardCounts.get(r.id) ?? { total: 0, active: 0 };
    return {
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      marketingConsentAt:
        r.marketingConsentAt instanceof Date
          ? r.marketingConsentAt.toISOString()
          : (r.marketingConsentAt as string | null),
      lastVisit: lastVisits.get(r.id) ?? null,
      activeCards: cc.active,
      totalCards: cc.total,
    };
  });

  // Apply post-filters that need the enriched data.
  if (filters.hasActiveCard === true) enriched = enriched.filter((r) => r.activeCards > 0);
  if (filters.hasActiveCard === false) enriched = enriched.filter((r) => r.activeCards === 0);
  if (filters.dormantSinceDays !== undefined) {
    const cutoff = daysAgo(now, filters.dormantSinceDays).getTime();
    enriched = enriched.filter((r) => !r.lastVisit || new Date(r.lastVisit).getTime() < cutoff);
  }

  // lastVisit sort happens here because it's not on the base table.
  if (filters.sort === 'lastVisit') {
    enriched.sort((a, b) => {
      const av = a.lastVisit ? new Date(a.lastVisit).getTime() : 0;
      const bv = b.lastVisit ? new Date(b.lastVisit).getTime() : 0;
      return filters.sortDir === 'asc' ? av - bv : bv - av;
    });
  }

  return enriched;
};

export interface CardsReportFilters {
  q?: string;
  status?: 'active' | 'expired' | 'cancelled';
  source?: 'pos' | 'online' | 'manual';
  soldFrom?: Date;
  soldTo?: Date;
  expiringWithinDays?: number;
  /** Inclusive: minimum usedEntries / totalEntries percentage 0..100. */
  usageMinPct?: number;
  /** Inclusive: maximum percentage. */
  usageMaxPct?: number;
  limit?: number;
  sort?: 'createdAt' | 'expiresAt' | 'usedEntries' | 'serialNumber';
  sortDir?: 'asc' | 'desc';
}

export interface CardsReportRow {
  id: string;
  serialNumber: string;
  customerId: string;
  customerNumber: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  customerPhone: string | null;
  totalEntries: number;
  usedEntries: number;
  isActive: boolean;
  expiresAt: string | null;
  cancelledAt: string | null;
  source: string;
  createdAt: string;
  usagePct: number;
}

export const cardsReport = async (
  db: AnyPgDatabase,
  filters: CardsReportFilters = {},
  now: Date = new Date(),
): Promise<CardsReportRow[]> => {
  const limit = Math.min(filters.limit ?? REPORT_DEFAULT_LIMIT, REPORT_MAX_LIMIT);
  const conds = [];
  const q = filters.q?.trim();
  if (q) {
    const p = `%${q}%`;
    const qC = or(
      ilike(punchCards.serialNumber, p),
      ilike(customers.firstName, p),
      ilike(customers.lastName, p),
      ilike(customers.phone, p),
      ilike(customers.customerNumber, p),
    );
    if (qC) conds.push(qC);
  }
  if (filters.status === 'active') conds.push(eq(punchCards.isActive, true));
  if (filters.status === 'cancelled') conds.push(isNotNull(punchCards.cancelledAt));
  if (filters.status === 'expired') {
    conds.push(eq(punchCards.isActive, false));
    conds.push(isNull(punchCards.cancelledAt));
  }
  if (filters.source) conds.push(eq(punchCards.source, filters.source));
  if (filters.soldFrom) conds.push(gte(punchCards.createdAt, filters.soldFrom));
  if (filters.soldTo) conds.push(lte(punchCards.createdAt, filters.soldTo));
  if (filters.expiringWithinDays !== undefined) {
    conds.push(isNotNull(punchCards.expiresAt));
    conds.push(gte(punchCards.expiresAt, now));
    conds.push(lt(punchCards.expiresAt, daysAhead(now, filters.expiringWithinDays)));
  }

  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  const sortCol =
    filters.sort === 'expiresAt'
      ? punchCards.expiresAt
      : filters.sort === 'usedEntries'
        ? punchCards.usedEntries
        : filters.sort === 'serialNumber'
          ? punchCards.serialNumber
          : punchCards.createdAt;
  const sortFn = filters.sortDir === 'asc' ? asc : desc;

  let query = db
    .select({
      id: punchCards.id,
      serialNumber: punchCards.serialNumber,
      customerId: punchCards.customerId,
      customerNumber: customers.customerNumber,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      customerPhone: customers.phone,
      totalEntries: punchCards.totalEntries,
      usedEntries: punchCards.usedEntries,
      isActive: punchCards.isActive,
      expiresAt: punchCards.expiresAt,
      cancelledAt: punchCards.cancelledAt,
      source: punchCards.source,
      createdAt: punchCards.createdAt,
    })
    .from(punchCards)
    .leftJoin(customers, eq(customers.id, punchCards.customerId))
    .$dynamic();
  if (where) query = query.where(where);
  const baseRows = await query.orderBy(sortFn(sortCol)).limit(limit);

  let enriched: CardsReportRow[] = baseRows.map((r) => ({
    ...r,
    expiresAt: r.expiresAt instanceof Date ? r.expiresAt.toISOString() : (r.expiresAt as string | null),
    cancelledAt:
      r.cancelledAt instanceof Date
        ? r.cancelledAt.toISOString()
        : (r.cancelledAt as string | null),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    usagePct: r.totalEntries === 0 ? 0 : Math.round((r.usedEntries / r.totalEntries) * 100),
  }));

  if (filters.usageMinPct !== undefined) {
    enriched = enriched.filter((r) => r.usagePct >= filters.usageMinPct!);
  }
  if (filters.usageMaxPct !== undefined) {
    enriched = enriched.filter((r) => r.usagePct <= filters.usageMaxPct!);
  }
  return enriched;
};

export interface EntriesReportFilters {
  from?: Date;
  to?: Date;
  customerId?: string;
  cardSerial?: string;
  method?: 'qr_scan' | 'serial' | 'phone' | 'manual' | 'online';
  /** undefined = either, true = only refunded, false = only non-refunded. */
  refunded?: boolean;
  punchedBy?: string;
  limit?: number;
  offset?: number;
}

export interface EntriesReportRow {
  id: string;
  punchedAt: string;
  method: string;
  entriesConsumed: number;
  refundedAt: string | null;
  refundReason: string | null;
  cardId: string;
  cardSerial: string;
  customerId: string;
  customerNumber: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  staffId: string | null;
  staffFirstName: string | null;
  staffLastName: string | null;
}

export interface EntriesReportPage {
  rows: EntriesReportRow[];
  total: number;
}

export const entriesReport = async (
  db: AnyPgDatabase,
  filters: EntriesReportFilters = {},
): Promise<EntriesReportPage> => {
  const limit = Math.min(filters.limit ?? REPORT_DEFAULT_LIMIT, REPORT_MAX_LIMIT);
  const offset = Math.max(0, filters.offset ?? 0);
  const conds = [];
  if (filters.from) conds.push(gte(punchCardEntries.punchedAt, filters.from));
  if (filters.to) conds.push(lte(punchCardEntries.punchedAt, filters.to));
  if (filters.method) conds.push(eq(punchCardEntries.method, filters.method));
  if (filters.refunded === true) conds.push(isNotNull(punchCardEntries.refundedAt));
  if (filters.refunded === false) conds.push(isNull(punchCardEntries.refundedAt));
  if (filters.punchedBy) conds.push(eq(punchCardEntries.punchedBy, filters.punchedBy));
  if (filters.customerId) conds.push(eq(punchCards.customerId, filters.customerId));
  if (filters.cardSerial) conds.push(ilike(punchCards.serialNumber, `%${filters.cardSerial.trim()}%`));

  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  let rowsQuery = db
    .select({
      id: punchCardEntries.id,
      punchedAt: punchCardEntries.punchedAt,
      method: punchCardEntries.method,
      entriesConsumed: punchCardEntries.entriesConsumed,
      refundedAt: punchCardEntries.refundedAt,
      refundReason: punchCardEntries.refundReason,
      cardId: punchCards.id,
      cardSerial: punchCards.serialNumber,
      customerId: punchCards.customerId,
      customerNumber: customers.customerNumber,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      staffId: punchCardEntries.punchedBy,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
    })
    .from(punchCardEntries)
    .leftJoin(punchCards, eq(punchCards.id, punchCardEntries.punchCardId))
    .leftJoin(customers, eq(customers.id, punchCards.customerId))
    .leftJoin(staff, eq(staff.id, punchCardEntries.punchedBy))
    .$dynamic();
  if (where) rowsQuery = rowsQuery.where(where);
  const rawRows = await rowsQuery
    .orderBy(desc(punchCardEntries.punchedAt))
    .limit(limit)
    .offset(offset);

  // total count under the same filter set (no limit/offset).
  let countQuery = db
    .select({ n: count() })
    .from(punchCardEntries)
    .leftJoin(punchCards, eq(punchCards.id, punchCardEntries.punchCardId))
    .$dynamic();
  if (where) countQuery = countQuery.where(where);
  const totalRows = await countQuery;
  const total = Number(totalRows[0]?.n ?? 0);

  const rows: EntriesReportRow[] = rawRows.map((r) => ({
    id: r.id,
    punchedAt: r.punchedAt instanceof Date ? r.punchedAt.toISOString() : String(r.punchedAt),
    method: r.method,
    entriesConsumed: r.entriesConsumed,
    refundedAt:
      r.refundedAt instanceof Date ? r.refundedAt.toISOString() : (r.refundedAt as string | null),
    refundReason: r.refundReason,
    cardId: r.cardId ?? '',
    cardSerial: r.cardSerial ?? '',
    customerId: r.customerId ?? '',
    customerNumber: r.customerNumber,
    customerFirstName: r.customerFirstName,
    customerLastName: r.customerLastName,
    staffId: r.staffId,
    staffFirstName: r.staffFirstName,
    staffLastName: r.staffLastName,
  }));

  return { rows, total };
};

export interface RevenueReportFilters {
  from?: Date;
  to?: Date;
  groupBy?: 'day' | 'week' | 'month';
}

export interface RevenueReportRow {
  period: string;
  cardsSold: number;
  /** Paid additional companions on bookings confirmed in this period (Yanay 2026-07-01). */
  companionsSold: number;
  estimatedRevenueShekels: number;
}

export interface RevenueReportResult {
  rows: RevenueReportRow[];
  estimatedFromPriceShekels: number;
  totalCardsSold: number;
  totalCompanionsSold: number;
  totalEstimatedRevenueShekels: number;
}

/**
 * Revenue report. Bucket cards-sold by day/week/month, then multiply by the
 * CURRENT settings.priceShekels to estimate revenue. Honest caveat: real
 * price-at-sale isn't stored. Returns the assumed price so the UI can show
 * the user what's being multiplied.
 *
 * Also buckets paid additional companions (bookings.additional_companions,
 * source paid/gift, status confirmed/used, by confirmed_at) into the same
 * periods so the admin can see companion sales next to card sales. The
 * revenue estimate stays cards-only — companion revenue already shows on the
 * live dashboard, and mixing two estimated price bases in one column would
 * muddy the "estimated from price X" caveat.
 */
export const revenueReport = async (
  db: AnyPgDatabase,
  filters: RevenueReportFilters = {},
): Promise<RevenueReportResult> => {
  const groupBy = filters.groupBy ?? 'day';
  const conds = [
    // We exclude cancelled cards from "sold" — cancelled = refunded/returned.
    isNull(punchCards.cancelledAt),
  ];
  if (filters.from) conds.push(gte(punchCards.createdAt, filters.from));
  if (filters.to) conds.push(lte(punchCards.createdAt, filters.to));

  const where = conds.length === 1 ? conds[0] : and(...conds);

  // Bucket expression per groupBy.
  const bucketSql =
    groupBy === 'day'
      ? sql<string>`to_char(${punchCards.createdAt}, 'YYYY-MM-DD')`
      : groupBy === 'week'
        ? sql<string>`to_char(date_trunc('week', ${punchCards.createdAt}), 'IYYY-"W"IW')`
        : sql<string>`to_char(${punchCards.createdAt}, 'YYYY-MM')`;

  const rowsRaw = await db
    .select({
      period: bucketSql,
      cardsSold: sql<number>`cast(count(*) as int)`,
    })
    .from(punchCards)
    .where(where)
    .groupBy(bucketSql)
    .orderBy(bucketSql);

  // Companions bucketed by booking confirmed_at with the same period shape.
  const companionBucketSql =
    groupBy === 'day'
      ? sql<string>`to_char(${bookings.confirmedAt}, 'YYYY-MM-DD')`
      : groupBy === 'week'
        ? sql<string>`to_char(date_trunc('week', ${bookings.confirmedAt}), 'IYYY-"W"IW')`
        : sql<string>`to_char(${bookings.confirmedAt}, 'YYYY-MM')`;

  const companionConds = [
    sql`${bookings.status} IN ('confirmed','used')`,
    sql`${bookings.source} IN ('paid','gift')`,
    isNotNull(bookings.confirmedAt),
    sql`${bookings.additionalCompanions} > 0`,
  ];
  if (filters.from) companionConds.push(gte(bookings.confirmedAt, filters.from));
  if (filters.to) companionConds.push(lte(bookings.confirmedAt, filters.to));

  const companionRowsRaw = await db
    .select({
      period: companionBucketSql,
      companionsSold: sql<string>`COALESCE(SUM(${bookings.additionalCompanions}), 0)`,
    })
    .from(bookings)
    .where(and(...companionConds))
    .groupBy(companionBucketSql)
    .orderBy(companionBucketSql);

  // Pull current price from settings for the estimate.
  const settingsRows = await db.select().from(cardSettings).limit(1);
  const fallbackPrice = (await getCardSettings(db)).priceShekels;
  const estimatedFromPriceShekels = settingsRows[0]?.priceShekels ?? fallbackPrice;

  // Merge the two bucket sets — a period can have cards without companions
  // and vice versa, so the row list is the sorted union.
  const byPeriod = new Map<string, { cardsSold: number; companionsSold: number }>();
  for (const r of rowsRaw) {
    byPeriod.set(r.period, { cardsSold: Number(r.cardsSold), companionsSold: 0 });
  }
  for (const r of companionRowsRaw) {
    const existing = byPeriod.get(r.period) ?? { cardsSold: 0, companionsSold: 0 };
    existing.companionsSold = Number(r.companionsSold);
    byPeriod.set(r.period, existing);
  }

  const rows: RevenueReportRow[] = [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, counts]) => ({
      period,
      cardsSold: counts.cardsSold,
      companionsSold: counts.companionsSold,
      estimatedRevenueShekels: counts.cardsSold * estimatedFromPriceShekels,
    }));

  const totalCardsSold = rows.reduce((acc, r) => acc + r.cardsSold, 0);
  const totalCompanionsSold = rows.reduce((acc, r) => acc + r.companionsSold, 0);
  const totalEstimatedRevenueShekels = totalCardsSold * estimatedFromPriceShekels;

  return {
    rows,
    estimatedFromPriceShekels,
    totalCardsSold,
    totalCompanionsSold,
    totalEstimatedRevenueShekels,
  };
};

// ---------------------------------------------------------------------------
// Cancellations report — unified feed of card cancellations + entry refunds.
// Both event types share an "occurred → reason → who did it" shape, so the
// admin sees one chronological list and can drill into either.
// ---------------------------------------------------------------------------

export type CancellationKind = 'card' | 'entry';

export interface CancellationsReportFilters {
  /** Earliest occurredAt (cancelledAt / refundedAt). */
  from?: Date;
  /** Latest occurredAt. */
  to?: Date;
  /** Restrict to card cancellations or entry refunds. Default: both. */
  kind?: CancellationKind;
  /** ILIKE across card serial + customer name / phone / number. */
  q?: string;
  /** Page size after merging the two sources. Capped at REPORT_MAX_LIMIT. */
  limit?: number;
  offset?: number;
}

export interface CancellationsReportRow {
  kind: CancellationKind;
  /** card.id when kind='card', entry.id when kind='entry'. Unique within its kind. */
  id: string;
  occurredAt: string;
  reason: string | null;
  cardId: string;
  cardSerial: string;
  customerId: string;
  customerNumber: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  /** Staff who cancelled the card / refunded the entry. */
  actorId: string | null;
  actorFirstName: string | null;
  actorLastName: string | null;
  // Entry-only fields:
  method: string | null;
  entriesConsumed: number | null;
  originalPunchedAt: string | null;
  // Card-only fields:
  source: string | null;
  usedEntries: number | null;
  totalEntries: number | null;
}

export interface CancellationsReportPage {
  rows: CancellationsReportRow[];
  total: number;
  /** Total card-cancellation events that matched the filter (pre-pagination). */
  cardCount: number;
  /** Total entry-refund events that matched the filter (pre-pagination). */
  entryCount: number;
}

export const cancellationsReport = async (
  db: AnyPgDatabase,
  filters: CancellationsReportFilters = {},
): Promise<CancellationsReportPage> => {
  const limit = Math.min(filters.limit ?? REPORT_DEFAULT_LIMIT, REPORT_MAX_LIMIT);
  const offset = Math.max(0, filters.offset ?? 0);
  const q = filters.q?.trim();
  const qPattern = q ? `%${q}%` : null;

  // ----- Card cancellations -----
  let cardRows: CancellationsReportRow[] = [];
  if (filters.kind !== 'entry') {
    const cardConds = [isNotNull(punchCards.cancelledAt)];
    if (filters.from) cardConds.push(gte(punchCards.cancelledAt, filters.from));
    if (filters.to) cardConds.push(lte(punchCards.cancelledAt, filters.to));
    if (qPattern) {
      const qC = or(
        ilike(punchCards.serialNumber, qPattern),
        ilike(customers.firstName, qPattern),
        ilike(customers.lastName, qPattern),
        ilike(customers.phone, qPattern),
        ilike(customers.customerNumber, qPattern),
      );
      if (qC) cardConds.push(qC);
    }

    const raw = await db
      .select({
        id: punchCards.id,
        cancelledAt: punchCards.cancelledAt,
        cancelReason: punchCards.cancelReason,
        cardSerial: punchCards.serialNumber,
        customerId: punchCards.customerId,
        customerNumber: customers.customerNumber,
        customerFirstName: customers.firstName,
        customerLastName: customers.lastName,
        actorId: punchCards.cancelledBy,
        actorFirstName: staff.firstName,
        actorLastName: staff.lastName,
        source: punchCards.source,
        usedEntries: punchCards.usedEntries,
        totalEntries: punchCards.totalEntries,
      })
      .from(punchCards)
      .leftJoin(customers, eq(customers.id, punchCards.customerId))
      .leftJoin(staff, eq(staff.id, punchCards.cancelledBy))
      .where(and(...cardConds))
      .orderBy(desc(punchCards.cancelledAt));

    cardRows = raw.map((r) => ({
      kind: 'card',
      id: r.id,
      occurredAt:
        r.cancelledAt instanceof Date ? r.cancelledAt.toISOString() : String(r.cancelledAt),
      reason: r.cancelReason,
      cardId: r.id,
      cardSerial: r.cardSerial,
      customerId: r.customerId ?? '',
      customerNumber: r.customerNumber,
      customerFirstName: r.customerFirstName,
      customerLastName: r.customerLastName,
      actorId: r.actorId,
      actorFirstName: r.actorFirstName,
      actorLastName: r.actorLastName,
      method: null,
      entriesConsumed: null,
      originalPunchedAt: null,
      source: r.source,
      usedEntries: r.usedEntries,
      totalEntries: r.totalEntries,
    }));
  }

  // ----- Entry refunds -----
  let entryRows: CancellationsReportRow[] = [];
  if (filters.kind !== 'card') {
    // Alias the staff join so it stays unambiguous if a future change adds
    // another staff join here (e.g. approvedBy).
    const refundActor = alias(staff, 'refund_actor');

    const entryConds = [isNotNull(punchCardEntries.refundedAt)];
    if (filters.from) entryConds.push(gte(punchCardEntries.refundedAt, filters.from));
    if (filters.to) entryConds.push(lte(punchCardEntries.refundedAt, filters.to));
    if (qPattern) {
      const qC = or(
        ilike(punchCards.serialNumber, qPattern),
        ilike(customers.firstName, qPattern),
        ilike(customers.lastName, qPattern),
        ilike(customers.phone, qPattern),
        ilike(customers.customerNumber, qPattern),
      );
      if (qC) entryConds.push(qC);
    }

    const raw = await db
      .select({
        id: punchCardEntries.id,
        refundedAt: punchCardEntries.refundedAt,
        refundReason: punchCardEntries.refundReason,
        method: punchCardEntries.method,
        entriesConsumed: punchCardEntries.entriesConsumed,
        originalPunchedAt: punchCardEntries.punchedAt,
        cardId: punchCards.id,
        cardSerial: punchCards.serialNumber,
        customerId: punchCards.customerId,
        customerNumber: customers.customerNumber,
        customerFirstName: customers.firstName,
        customerLastName: customers.lastName,
        actorId: punchCardEntries.refundedBy,
        actorFirstName: refundActor.firstName,
        actorLastName: refundActor.lastName,
      })
      .from(punchCardEntries)
      .leftJoin(punchCards, eq(punchCards.id, punchCardEntries.punchCardId))
      .leftJoin(customers, eq(customers.id, punchCards.customerId))
      .leftJoin(refundActor, eq(refundActor.id, punchCardEntries.refundedBy))
      .where(and(...entryConds))
      .orderBy(desc(punchCardEntries.refundedAt));

    entryRows = raw.map((r) => ({
      kind: 'entry',
      id: r.id,
      occurredAt:
        r.refundedAt instanceof Date ? r.refundedAt.toISOString() : String(r.refundedAt),
      reason: r.refundReason,
      cardId: r.cardId ?? '',
      cardSerial: r.cardSerial ?? '',
      customerId: r.customerId ?? '',
      customerNumber: r.customerNumber,
      customerFirstName: r.customerFirstName,
      customerLastName: r.customerLastName,
      actorId: r.actorId,
      actorFirstName: r.actorFirstName,
      actorLastName: r.actorLastName,
      method: r.method,
      entriesConsumed: r.entriesConsumed,
      originalPunchedAt:
        r.originalPunchedAt instanceof Date
          ? r.originalPunchedAt.toISOString()
          : String(r.originalPunchedAt),
      source: null,
      usedEntries: null,
      totalEntries: null,
    }));
  }

  // Merge both sources, newest first, then page.
  const merged = [...cardRows, ...entryRows].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return {
    rows: merged.slice(offset, offset + limit),
    total: merged.length,
    cardCount: cardRows.length,
    entryCount: entryRows.length,
  };
};

// ---------------------------------------------------------------------------
// Tickets (entrance tickets = bookings) — feeds BOTH the admin ניהול כרטיסים
// screen and the דוחות section, so the two surfaces can never disagree.
// `held` rows are always excluded: a hold is a transient WC-checkout state
// with a TTL, not a ticket anyone should list or act on.
// ---------------------------------------------------------------------------

export type TicketStatus = 'confirmed' | 'used' | 'cancelled' | 'expired';
export type TicketSource = 'paid' | 'punchcard' | 'gift' | 'manual';
export type TicketType = 'child_under_walking' | 'child_over_walking';

const TICKET_STATUSES: TicketStatus[] = ['confirmed', 'used', 'cancelled', 'expired'];

export interface TicketsReportFilters {
  /** ILIKE across booking number + customer name / phone / number. */
  q?: string;
  status?: TicketStatus;
  source?: TicketSource;
  ticketType?: TicketType;
  /** Inclusive round-instance date bounds, YYYY-MM-DD. */
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
  sort?: 'date' | 'createdAt' | 'bookingNumber';
  sortDir?: 'asc' | 'desc';
}

export interface TicketsReportRow {
  bookingId: string;
  bookingNumber: string | null;
  customerId: string;
  customerNumber: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  customerPhone: string | null;
  roundInstanceId: string;
  /** YYYY-MM-DD */
  date: string;
  roundLabel: string;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  ticketType: TicketType;
  additionalCompanions: number;
  source: TicketSource;
  status: TicketStatus;
  /** Serial of the card that paid for this ticket (source='punchcard'). */
  punchCardSerial: string | null;
  wcOrderId: string | null;
  createdAt: string;
  usedAt: string | null;
}

/**
 * Status distribution of the filtered set, computed WITHOUT the status filter
 * so the tiles/chips keep showing the whole picture while one bucket is open.
 */
export interface TicketsReportSummary {
  confirmed: number;
  used: number;
  cancelled: number;
  expired: number;
  /** Additional companions across the same (status-agnostic) set. */
  companions: number;
}

export interface TicketsReportPage {
  rows: TicketsReportRow[];
  /** Rows matching ALL filters (pre-pagination). */
  total: number;
  summary: TicketsReportSummary;
}

const hhmm = (t: string): string => t.slice(0, 5);

export const ticketsReport = async (
  db: AnyPgDatabase,
  filters: TicketsReportFilters = {},
): Promise<TicketsReportPage> => {
  const limit = Math.min(filters.limit ?? REPORT_DEFAULT_LIMIT, REPORT_MAX_LIMIT);
  const offset = Math.max(0, filters.offset ?? 0);

  // Conditions shared by the rows query and the summary query — everything
  // except the status filter, which the summary deliberately ignores.
  const baseConds = [inArray(bookings.status, TICKET_STATUSES)];
  const q = filters.q?.trim();
  if (q) {
    const p = `%${q}%`;
    const qC = or(
      ilike(bookings.bookingNumber, p),
      ilike(customers.firstName, p),
      ilike(customers.lastName, p),
      ilike(customers.phone, p),
      ilike(customers.customerNumber, p),
    );
    if (qC) baseConds.push(qC);
  }
  if (filters.source) baseConds.push(eq(bookings.source, filters.source));
  if (filters.ticketType) baseConds.push(eq(bookings.ticketType, filters.ticketType));
  if (filters.dateFrom) baseConds.push(gte(roundInstances.date, filters.dateFrom));
  if (filters.dateTo) baseConds.push(lte(roundInstances.date, filters.dateTo));

  const rowConds = [...baseConds];
  if (filters.status) rowConds.push(eq(bookings.status, filters.status));

  const sortDirFn = filters.sortDir === 'asc' ? asc : desc;
  const orderBy =
    filters.sort === 'createdAt'
      ? [sortDirFn(bookings.createdAt)]
      : filters.sort === 'bookingNumber'
        ? [sortDirFn(bookings.bookingNumber)]
        : // Default: by round date, mornings before evenings inside a day,
          // newest booking first within the same round.
          [sortDirFn(roundInstances.date), asc(rounds.startTime), desc(bookings.createdAt)];

  const rawRows = await db
    .select({
      bookingId: bookings.id,
      bookingNumber: bookings.bookingNumber,
      customerId: bookings.customerId,
      customerNumber: customers.customerNumber,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      customerPhone: customers.phone,
      roundInstanceId: bookings.roundInstanceId,
      date: roundInstances.date,
      roundLabel: rounds.displayName,
      startTime: rounds.startTime,
      endTime: rounds.endTime,
      ticketType: bookings.ticketType,
      additionalCompanions: bookings.additionalCompanions,
      source: bookings.source,
      status: bookings.status,
      punchCardSerial: punchCards.serialNumber,
      wcOrderId: bookings.wcOrderId,
      createdAt: bookings.createdAt,
      usedAt: bookings.usedAt,
    })
    .from(bookings)
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .innerJoin(rounds, eq(rounds.id, roundInstances.roundId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .leftJoin(punchCards, eq(punchCards.id, bookings.punchCardId))
    .where(and(...rowConds))
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  // One grouped pass covers the summary AND the total: with a status filter,
  // total = that status's bucket; without one, total = the sum of buckets.
  const grouped = await db
    .select({
      status: bookings.status,
      n: count(),
      companions: sql<string>`coalesce(sum(${bookings.additionalCompanions}), 0)`,
    })
    .from(bookings)
    .innerJoin(roundInstances, eq(roundInstances.id, bookings.roundInstanceId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(and(...baseConds))
    .groupBy(bookings.status);

  const summary: TicketsReportSummary = {
    confirmed: 0,
    used: 0,
    cancelled: 0,
    expired: 0,
    companions: 0,
  };
  for (const g of grouped) {
    summary[g.status as TicketStatus] = Number(g.n);
    summary.companions += Number(g.companions);
  }
  const total = filters.status
    ? summary[filters.status]
    : summary.confirmed + summary.used + summary.cancelled + summary.expired;

  const rows: TicketsReportRow[] = rawRows.map((r) => ({
    bookingId: r.bookingId,
    bookingNumber: r.bookingNumber,
    customerId: r.customerId,
    customerNumber: r.customerNumber,
    customerFirstName: r.customerFirstName,
    customerLastName: r.customerLastName,
    customerPhone: r.customerPhone,
    roundInstanceId: r.roundInstanceId,
    date: r.date,
    roundLabel: r.roundLabel,
    startTime: hhmm(r.startTime),
    endTime: hhmm(r.endTime),
    ticketType: r.ticketType as TicketType,
    additionalCompanions: r.additionalCompanions,
    source: r.source as TicketSource,
    status: r.status as TicketStatus,
    punchCardSerial: r.punchCardSerial,
    wcOrderId: r.wcOrderId,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    usedAt: r.usedAt instanceof Date ? r.usedAt.toISOString() : (r.usedAt as string | null),
  }));

  return { rows, total, summary };
};
