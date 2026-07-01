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
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createCustomer } from './cards';
import { createHold } from './rounds-hold';
import { createRound } from './rounds';
import { roundInstances } from './schema';

const url = process.env.TEST_DATABASE_URL;
const N = 16; // concurrent callers fighting for one seat

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
