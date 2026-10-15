// Demo seed for the rounds dashboard + staff view. Inserts a few round
// templates, materializes today's instances, and fills them with confirmed +
// held bookings and a waitlist so the dashboard/staff view render real
// occupancy, holds, waitlist, and revenue. Purely for eyeballing the display
// side — the real booking flow isn't built yet.
//
//   Seed:  pnpm --filter @memesh/api seed:rounds-demo
//   Clear: SEED_ROUNDS_DEMO_CLEAR=1 pnpm --filter @memesh/api seed:rounds-demo
//
// Idempotent: re-running rebuilds the same demo state. All demo rows are tagged
// by a `demo-` round label + a `052900xxxx` customer phone prefix, so clear
// removes exactly what this script created and nothing else.

import {
  bookings,
  createCustomer,
  createRound,
  customers,
  ensureUpcomingInstances,
  MIGRATIONS_FOLDER,
  roundInstances,
  rounds,
  updateRound,
  waitlistEntries,
  type NewBooking,
  type NewWaitlistEntry,
  type Round,
} from '@memesh/db';
import { and, eq, like } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { fileURLToPath } from 'node:url';

type AnyPgDatabase = PgDatabase<any, any, any>;

const CUSTOMER_PHONE_PREFIX = '052900';
const DEMO_CUSTOMER_COUNT = 12;
const HOLD_TTL_MS = 15 * 60 * 1000;

// Fill levels chosen to show the three status colors + a waitlist:
//   morning  10/40 = 25%  green
//   noon     38/50 = 76%  amber
//   afternoon 46/50 = 92% red + waitlist
const DEMO_ROUNDS = [
  {
    label: 'demo-morning',
    displayName: 'סבב בוקר (הדגמה)',
    startTime: '10:00',
    endTime: '12:00',
    capacity: 40,
    confirmed: 10,
    held: 0,
    waitlist: 0,
  },
  {
    label: 'demo-noon',
    displayName: 'סבב צהריים (הדגמה)',
    startTime: '13:00',
    endTime: '15:00',
    capacity: 50,
    confirmed: 36,
    held: 2,
    waitlist: 0,
  },
  {
    label: 'demo-afternoon',
    displayName: 'סבב אחר הצהריים (הדגמה)',
    startTime: '16:00',
    endTime: '18:00',
    capacity: 50,
    confirmed: 44,
    held: 2,
    waitlist: 5,
  },
] as const;

function toIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function randSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Find-or-create a stable pool of demo customers by phone. */
async function demoCustomerPool(db: AnyPgDatabase): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < DEMO_CUSTOMER_COUNT; i += 1) {
    const phone = `${CUSTOMER_PHONE_PREFIX}${String(1000 + i).slice(-4)}`;
    const existing = await db.select().from(customers).where(eq(customers.phone, phone)).limit(1);
    if (existing[0]) {
      ids.push(existing[0].id);
      continue;
    }
    const row = await createCustomer(db, {
      firstName: 'הדגמה',
      lastName: `לקוח ${i + 1}`,
      phone,
    });
    ids.push(row.id);
  }
  return ids;
}

async function findOrUpsertRound(
  db: AnyPgDatabase,
  cfg: (typeof DEMO_ROUNDS)[number],
  now: Date,
): Promise<Round> {
  const existing = await db.select().from(rounds).where(eq(rounds.label, cfg.label)).limit(1);
  if (existing[0]) {
    const res = await updateRound(
      db,
      existing[0].id,
      {
        displayName: cfg.displayName,
        startTime: cfg.startTime,
        endTime: cfg.endTime,
        defaultCapacity: cfg.capacity,
        daysActive: 127,
        isActive: true,
      },
      now,
    );
    if (!res.ok) throw new Error(`[seed rounds] update ${cfg.label}: ${JSON.stringify(res)}`);
    return res.round;
  }
  const created = await createRound(
    db,
    {
      label: cfg.label,
      displayName: cfg.displayName,
      startTime: cfg.startTime,
      endTime: cfg.endTime,
      daysActive: 127,
      defaultCapacity: cfg.capacity,
    },
    now,
  );
  if (!created.ok) throw new Error(`[seed rounds] create ${cfg.label}: ${JSON.stringify(created)}`);
  return created.round;
}

async function seedDemo(db: AnyPgDatabase): Promise<void> {
  const now = new Date();
  const todayIso = toIsoDate(now);
  const pool = await demoCustomerPool(db);
  console.info('[seed rounds] customer pool ready', { count: pool.length });

  let totalConfirmed = 0;
  let totalHeld = 0;
  let totalWaitlist = 0;

  for (const cfg of DEMO_ROUNDS) {
    const round = await findOrUpsertRound(db, cfg, now);
    await ensureUpcomingInstances(db, round, now);

    const instRows = await db
      .select()
      .from(roundInstances)
      .where(and(eq(roundInstances.roundId, round.id), eq(roundInstances.date, todayIso)))
      .limit(1);
    const inst = instRows[0];
    if (!inst) throw new Error(`[seed rounds] no instance for ${cfg.label} on ${todayIso}`);

    // Pin the instance capacity to the config, then clear prior demo rows so the
    // counts are exact on every run.
    await db.update(roundInstances).set({ capacity: cfg.capacity }).where(eq(roundInstances.id, inst.id));
    await db.delete(bookings).where(eq(bookings.roundInstanceId, inst.id));
    await db.delete(waitlistEntries).where(eq(waitlistEntries.roundInstanceId, inst.id));

    const rows: NewBooking[] = [];
    for (let i = 0; i < cfg.confirmed; i += 1) {
      rows.push({
        roundInstanceId: inst.id,
        customerId: pool[i % pool.length]!,
        ticketType: i % 2 === 0 ? 'child_over_walking' : 'child_under_walking',
        additionalCompanions: i % 4 === 0 ? 1 : 0,
        source: 'paid',
        status: 'confirmed',
        barcodeToken: `demo-${cfg.label}-c${i}-${randSuffix()}`,
        confirmedAt: now,
      });
    }
    for (let i = 0; i < cfg.held; i += 1) {
      rows.push({
        roundInstanceId: inst.id,
        customerId: pool[i % pool.length]!,
        ticketType: 'child_over_walking',
        additionalCompanions: 0,
        source: 'paid',
        status: 'held',
        holdExpiresAt: new Date(now.getTime() + HOLD_TTL_MS),
      });
    }
    if (rows.length) await db.insert(bookings).values(rows);

    const wl: NewWaitlistEntry[] = [];
    for (let i = 0; i < cfg.waitlist; i += 1) {
      const notified = i === 0;
      wl.push({
        roundInstanceId: inst.id,
        customerId: pool[i % pool.length]!,
        requestedType: 'child_over_walking',
        requestedCompanions: 0,
        status: notified ? 'notified' : 'waiting',
        notifiedAt: notified ? new Date(now.getTime() - 5 * 60 * 1000) : null,
        claimExpiresAt: notified ? new Date(now.getTime() + 55 * 60 * 1000) : null,
      });
    }
    if (wl.length) await db.insert(waitlistEntries).values(wl);

    totalConfirmed += cfg.confirmed;
    totalHeld += cfg.held;
    totalWaitlist += cfg.waitlist;
    console.info('[seed rounds] filled', {
      round: cfg.displayName,
      taken: cfg.confirmed + cfg.held,
      capacity: cfg.capacity,
      waitlist: cfg.waitlist,
    });
  }

  console.info('[seed rounds] done', {
    rounds: DEMO_ROUNDS.length,
    confirmed: totalConfirmed,
    held: totalHeld,
    waitlist: totalWaitlist,
    note: 'Open admin → לוח בקרה to see it. Revenue reflects the confirmed bookings today.',
  });
}

async function clearDemo(db: AnyPgDatabase): Promise<void> {
  for (const cfg of DEMO_ROUNDS) {
    const existing = await db.select().from(rounds).where(eq(rounds.label, cfg.label)).limit(1);
    const round = existing[0];
    if (!round) continue;
    const insts = await db
      .select({ id: roundInstances.id })
      .from(roundInstances)
      .where(eq(roundInstances.roundId, round.id));
    for (const inst of insts) {
      await db.delete(bookings).where(eq(bookings.roundInstanceId, inst.id));
      await db.delete(waitlistEntries).where(eq(waitlistEntries.roundInstanceId, inst.id));
    }
    await db.delete(roundInstances).where(eq(roundInstances.roundId, round.id));
    await db.delete(rounds).where(eq(rounds.id, round.id));
    console.info('[seed rounds] cleared round', { label: cfg.label });
  }
  // Demo customers are unreferenced once their bookings/waitlist are gone.
  await db.delete(customers).where(like(customers.phone, `${CUSTOMER_PHONE_PREFIX}%`));
  console.info('[seed rounds] cleared demo customers');
}

// ---------------------------------------------------------------------------
// CLI entry — runs migrations against the env DATABASE_URL, then seeds/clears.
// ---------------------------------------------------------------------------

async function runCli(): Promise<void> {
  const clear = process.env.SEED_ROUNDS_DEMO_CLEAR === '1' || process.env.SEED_ROUNDS_DEMO_CLEAR === 'true';
  const [{ db, pool }, { migrate }] = await Promise.all([
    import('@memesh/db'),
    import('drizzle-orm/node-postgres/migrator'),
  ]);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    if (clear) {
      console.info('[seed rounds] clearing demo data');
      await clearDemo(db);
    } else {
      console.info('[seed rounds] seeding demo data');
      await seedDemo(db);
    }
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === entryPath) {
  await runCli();
}
