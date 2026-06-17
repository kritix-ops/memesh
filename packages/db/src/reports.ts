import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getCustomerById } from './accounts';
import { customers, punchCardEntries, punchCards } from './schema/index';

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
