// Proves the oversell guard under REAL concurrency: N parallel createHold calls
// against a capacity-1 round, and exactly one wins. PGlite cannot test this —
// it is single-connection, so the SELECT ... FOR UPDATE lock in createHold is
// never actually contended. This runs only when TEST_DATABASE_URL points at a
// real Postgres (which gives a multi-connection pool, so the holds truly race);
// it is skipped otherwise.
//
//   TEST_DATABASE_URL=postgres://user:pass@host:5432/db \
//     pnpm --filter @memesh/db test:concurrency

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KeyResolver } from '@memesh/qr-engine';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createCustomer, createPunchCard } from './cards';
import { cancelBooking } from './rounds-cancel';
import { createHold } from './rounds-hold';
import { bookRoundWithPunch } from './rounds-punch';
import { createRound } from './rounds';
import { punchCardEntries, punchCards, roundInstances } from './schema';

const url = process.env.TEST_DATABASE_URL;
const N = 16; // concurrent callers fighting for one seat

const SECRET = 'a-booking-secret-at-least-32-chars!!';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: '1', secret: SECRET }),
  resolveVerifyKey: (id) => (id === '1' ? SECRET : undefined),
};

test(
  'createHold cannot oversell a capacity-1 round under concurrent callers',
  { skip: url ? false : 'set TEST_DATABASE_URL to run (needs real Postgres)' },
  async () => {
    const pool = new Pool({ connectionString: url, max: N + 4 });
    const db = drizzle({ client: pool });
    try {
      await migrate(db, { migrationsFolder: './migrations' });

      const NOW = new Date('2026-07-01T10:00:00Z');
      const FUTURE = '2026-07-11';
      // Run-unique so repeated runs against a persistent DB don't collide.
      const tag = Math.floor(1000 + Math.random() * 9000);

      const r = await createRound(
        db,
        { label: `cc-${tag}`, displayName: 'CC', startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 1 },
        NOW,
      );
      if (!r.ok) throw new Error('round create failed');
      const inst = (
        await db
          .select()
          .from(roundInstances)
          .where(and(eq(roundInstances.roundId, r.round.id), eq(roundInstances.date, FUTURE)))
          .limit(1)
      )[0];
      if (!inst) throw new Error('no future instance');

      const customers = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          createCustomer(db, { firstName: 'c', lastName: String(i), phone: `05${tag}${String(i).padStart(4, '0')}` }),
        ),
      );

      // Fire every hold at once. Each createHold opens its own transaction on a
      // separate pooled connection, so they genuinely contend on the round row.
      const results = await Promise.all(
        customers.map((c) =>
          createHold(db, { roundInstanceId: inst.id, customerId: c.id, ticketType: 'child_over_walking' }, NOW),
        ),
      );

      const won = results.filter((x) => x.ok).length;
      const soldOut = results.filter((x) => !x.ok && x.error === 'sold_out').length;
      assert.equal(won, 1, `exactly one hold should win the single seat, got ${won}`);
      assert.equal(soldOut, N - 1, `the other ${N - 1} should be sold_out, got ${soldOut}`);
    } finally {
      await pool.end();
    }
  },
);

// Audit finding ②: two concurrent cancels of the SAME punch booking must return
// the entry exactly ONCE. Without the `WHERE refunded_at IS NULL` guard in
// rounds-cancel.ts, both callers read refunded_at = null before either commits,
// both decrement usedEntries, and a second (still-consumed) entry on the card is
// silently erased — a free entry. The single-entry case is hidden by the
// Math.max(0, ...) clamp, so the card must carry a second booking to expose it.
// Like the oversell test, this needs REAL Postgres (PGlite is single-connection).
test(
  'concurrent cancels of one punch booking return exactly one entry (no double-credit)',
  { skip: url ? false : 'set TEST_DATABASE_URL to run (needs real Postgres)' },
  async () => {
    const pool = new Pool({ connectionString: url, max: 8 });
    const db = drizzle({ client: pool });
    try {
      await migrate(db, { migrationsFolder: './migrations' });

      const NOW = new Date('2026-07-01T10:00:00Z');
      const FUTURE = '2026-07-11';
      const tag = Math.floor(1000 + Math.random() * 9000);

      // Two rounds so the same card holds two consumed entries.
      const instFor = async (label: string) => {
        const r = await createRound(
          db,
          { label, displayName: label, startTime: '16:00', endTime: '18:00', daysActive: 127, defaultCapacity: 5 },
          NOW,
        );
        if (!r.ok) throw new Error('round create failed');
        const inst = (
          await db
            .select()
            .from(roundInstances)
            .where(and(eq(roundInstances.roundId, r.round.id), eq(roundInstances.date, FUTURE)))
            .limit(1)
        )[0];
        if (!inst) throw new Error('no future instance');
        return inst.id;
      };
      const instA = await instFor(`rc-a-${tag}`);
      const instB = await instFor(`rc-b-${tag}`);

      const cust = await createCustomer(db, { firstName: 'c', lastName: String(tag), phone: `054${tag}0001` });
      const card = await createPunchCard(db, resolver, { customerId: cust.id, totalEntries: 12, validityDays: 0, now: NOW });

      const bookA = await bookRoundWithPunch(db, { roundInstanceId: instA, customerId: cust.id, punchCardId: card.id, ticketType: 'child_over_walking' }, resolver, NOW);
      const bookB = await bookRoundWithPunch(db, { roundInstanceId: instB, customerId: cust.id, punchCardId: card.id, ticketType: 'child_over_walking' }, resolver, NOW);
      if (!bookA.ok || !bookB.ok) throw new Error('punch booking failed');
      const bookingA = bookA.bookings[0]!.bookingId;

      // usedEntries is now 2. Fire two cancels of booking A at once.
      const refund = async () => true; // no money path for a punch-only booking
      const [r1, r2] = await Promise.all([
        cancelBooking(db, { bookingId: bookingA, customerId: cust.id }, { refund }, NOW),
        cancelBooking(db, { bookingId: bookingA, customerId: cust.id }, { refund }, NOW),
      ]);

      // Both may return ok (the losing one just no-ops the entry), but exactly
      // one may have actually returned the punch.
      const returnedCount = [r1, r2].filter((r) => r.ok && r.punchReturned).length;
      assert.equal(returnedCount, 1, `exactly one cancel returns the punch, got ${returnedCount}`);

      const cardRow = (await db.select().from(punchCards).where(eq(punchCards.id, card.id)).limit(1))[0];
      assert.equal(cardRow!.usedEntries, 1, `booking B's entry must remain consumed, got ${cardRow!.usedEntries}`);
      const entryA = (await db.select().from(punchCardEntries).where(eq(punchCardEntries.idempotencyKey, bookingA)).limit(1))[0];
      assert.ok(entryA!.refundedAt !== null, 'booking A entry is refunded exactly once');
    } finally {
      await pool.end();
    }
  },
);
