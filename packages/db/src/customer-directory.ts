import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  ilike,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { customers, punchCards, type Customer } from './schema/index';

type AnyPgDatabase = PgDatabase<any, any, any>;

// ---------------------------------------------------------------------------
// Customer directory — the paginated browse/search surface behind the staff
// "חיפוש לקוח" screen (and the admin Customers tab). Unlike customersReport
// in reports.ts, every filter and sort here runs in SQL BEFORE limit/offset,
// so pages stay correct: filtering after the limit would silently drop rows
// from later pages.
// ---------------------------------------------------------------------------

export type CustomerDirectorySort = 'name' | 'newest' | 'oldest' | 'lastPurchase';
export type CustomerDirectoryStatus = 'active' | 'frozen' | 'vip';

export interface ListCustomersOptions {
  /** Free text matched against name, phone, customer number, and email. */
  q?: string;
  /** Default 'newest' (createdAt desc) — the legacy /customers ordering. */
  sort?: CustomerDirectorySort;
  status?: CustomerDirectoryStatus;
  /** true = only customers with an active card; false = only without. */
  hasActiveCard?: boolean;
  limit?: number;
  offset?: number;
}

export interface CustomerDirectoryRow extends Customer {
  /** ISO timestamp of the customer's most recent card purchase, null if none. */
  lastPurchaseAt: string | null;
}

export interface ListCustomersResult {
  results: CustomerDirectoryRow[];
  /** Count of ALL rows matching the filters, not just this page. */
  total: number;
}

const DIRECTORY_DEFAULT_LIMIT = 50;
const DIRECTORY_MAX_LIMIT = 100;

export const listCustomers = async (
  db: AnyPgDatabase,
  opts: ListCustomersOptions = {},
): Promise<ListCustomersResult> => {
  const limit = Math.min(Math.max(opts.limit ?? DIRECTORY_DEFAULT_LIMIT, 1), DIRECTORY_MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conds = [];
  const q = opts.q?.trim();
  if (q) {
    // Token-AND search: every whitespace-separated token must match at least
    // one field. This is what lets "נועה כהן" find first="נועה" last="כהן" —
    // a single ILIKE '%נועה כהן%' would miss it because the full name never
    // appears in one column.
    for (const token of q.split(/\s+/)) {
      const p = `%${token}%`;
      const tokenCond = or(
        ilike(customers.firstName, p),
        ilike(customers.lastName, p),
        ilike(customers.phone, p),
        ilike(customers.customerNumber, p),
        ilike(customers.email, p),
      );
      if (tokenCond) conds.push(tokenCond);
    }
  }
  if (opts.status) conds.push(eq(customers.status, opts.status));
  if (opts.hasActiveCard !== undefined) {
    const activeCards = db
      .select({ id: punchCards.id })
      .from(punchCards)
      .where(and(eq(punchCards.customerId, customers.id), eq(punchCards.isActive, true)));
    conds.push(opts.hasActiveCard ? exists(activeCards) : notExists(activeCards));
  }
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  // Most recent card purchase per customer, joined onto every page so the UI
  // can show it regardless of the chosen sort.
  const lastPurchase = db
    .select({
      customerId: punchCards.customerId,
      lastPurchaseAt: sql<Date | string | null>`max(${punchCards.createdAt})`.as(
        'last_purchase_at',
      ),
    })
    .from(punchCards)
    .groupBy(punchCards.customerId)
    .as('last_purchase');

  // lower() keeps mixed-case Latin names in one alphabet under a C collation;
  // Hebrew is unaffected (א..ת are consecutive codepoints either way).
  const sort = opts.sort ?? 'newest';
  const orderBy =
    sort === 'name'
      ? [asc(sql`lower(${customers.firstName})`), asc(sql`lower(${customers.lastName})`)]
      : sort === 'oldest'
        ? [asc(customers.createdAt)]
        : sort === 'lastPurchase'
          ? [
              // NULLS LAST: customers who never bought sink to the bottom
              // instead of leading the "recent buyers" sort.
              sql`${lastPurchase.lastPurchaseAt} desc nulls last`,
              asc(sql`lower(${customers.firstName})`),
              asc(sql`lower(${customers.lastName})`),
            ]
          : [desc(customers.createdAt)];

  // Sequential, not Promise.all: PGlite (tests) is single-connection.
  const totalRows = await db.select({ n: count() }).from(customers).where(where);
  const total = Number(totalRows[0]?.n ?? 0);

  const rows = await db
    .select({ ...getTableColumns(customers), lastPurchaseAt: lastPurchase.lastPurchaseAt })
    .from(customers)
    .leftJoin(lastPurchase, eq(lastPurchase.customerId, customers.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  // Raw max() aggregates bypass the driver's Date mapping on some drivers
  // (PGlite returns the pg text format, node-postgres returns a Date) —
  // normalize both to an ISO string so the API serializes consistently.
  const toIso = (v: Date | string | null): string | null => {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
  };
  const results: CustomerDirectoryRow[] = rows.map((r) => ({
    ...r,
    lastPurchaseAt: toIso(r.lastPurchaseAt),
  }));

  return { results, total };
};
