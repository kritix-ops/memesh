import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { customers, punchCardEntries, punchCards, scanAttempts, staff } from './schema/index';
import { punchCard } from './punch';

// Each test gets a fresh in-process Postgres (PGlite) with the real migrations
// applied, so the schema under test is the same SQL that ships to production.
async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

type TestDb = Awaited<ReturnType<typeof freshDb>>;

interface SeedOpts {
  used?: number;
  total?: number;
  isActive?: boolean;
  expiresAt?: Date;
}

let seq = 0;

async function seedCard(db: TestDb, opts: SeedOpts = {}) {
  seq += 1;
  const tag = String(seq).padStart(4, '0');

  const staffRows = await db
    .insert(staff)
    .values({ firstName: 'Shani', lastName: 'Dahan', phone: `050-000-${tag}`, role: 'cashier' })
    .returning({ id: staff.id });
  const staffRow = staffRows[0];
  assert.ok(staffRow);

  const custRows = await db
    .insert(customers)
    .values({
      customerNumber: `L-${tag}`,
      firstName: 'Noa',
      lastName: 'Cohen',
      phone: `052-${tag}-00`,
    })
    .returning({ id: customers.id });
  const custRow = custRows[0];
  assert.ok(custRow);

  const cardRows = await db
    .insert(punchCards)
    .values({
      customerId: custRow.id,
      serialNumber: `M-20260617-${tag}`,
      qrToken: `tok-${tag}`,
      keyId: 'k1',
      totalEntries: opts.total ?? 12,
      usedEntries: opts.used ?? 0,
      isActive: opts.isActive ?? true,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: punchCards.id });
  const cardRow = cardRows[0];
  assert.ok(cardRow);

  return { cardId: cardRow.id, staffId: staffRow.id, customerId: custRow.id };
}

test('happy path: a punch consumes one entry and writes a success audit', async () => {
  const db = await freshDb();
  const { cardId, staffId } = await seedCard(db, { used: 0, total: 12 });

  const res = await punchCard(db, {
    punchCardId: cardId,
    punchedBy: staffId,
    method: 'qr_scan',
    companionCount: 2,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.replay, false);
    assert.equal(res.usedEntries, 1);
    assert.equal(res.remaining, 11);
  }

  const card = (await db.select().from(punchCards).where(eq(punchCards.id, cardId)))[0];
  assert.ok(card);
  assert.equal(card.usedEntries, 1);
  assert.equal(card.isActive, true);

  const entries = await db
    .select()
    .from(punchCardEntries)
    .where(eq(punchCardEntries.punchCardId, cardId));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.companionCount, 2);

  const audits = await db.select().from(scanAttempts);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.result, 'success');
});

test('exhaustion: the final entry deactivates the card', async () => {
  const db = await freshDb();
  const { cardId } = await seedCard(db, { used: 11, total: 12 });

  const last = await punchCard(db, { punchCardId: cardId, method: 'qr_scan' });
  assert.equal(last.ok, true);
  if (last.ok) {
    assert.equal(last.remaining, 0);
  }

  const card = (await db.select().from(punchCards).where(eq(punchCards.id, cardId)))[0];
  assert.ok(card);
  assert.equal(card.isActive, false);

  // Once deactivated, the next scan is rejected (inactive guard fires first).
  const extra = await punchCard(db, { punchCardId: cardId, method: 'qr_scan' });
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.equal(extra.reason, 'inactive');
});

test('a full but still-active card is rejected as exhausted', async () => {
  const db = await freshDb();
  const { cardId } = await seedCard(db, { used: 12, total: 12, isActive: true });

  const res = await punchCard(db, { punchCardId: cardId, method: 'manual' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'exhausted');
});

test('idempotency: repeating the same key does not punch twice', async () => {
  const db = await freshDb();
  const { cardId, staffId } = await seedCard(db, { used: 0, total: 12 });

  const first = await punchCard(db, {
    punchCardId: cardId,
    punchedBy: staffId,
    method: 'qr_scan',
    idempotencyKey: 'scan-abc',
  });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.replay, false);

  const second = await punchCard(db, {
    punchCardId: cardId,
    punchedBy: staffId,
    method: 'qr_scan',
    idempotencyKey: 'scan-abc',
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.replay, true);
    assert.equal(second.usedEntries, 1);
    assert.equal(second.remaining, 11);
  }

  const entries = await db
    .select()
    .from(punchCardEntries)
    .where(eq(punchCardEntries.punchCardId, cardId));
  assert.equal(entries.length, 1);

  const card = (await db.select().from(punchCards).where(eq(punchCards.id, cardId)))[0];
  assert.ok(card);
  assert.equal(card.usedEntries, 1);
});

test('expired card is rejected', async () => {
  const db = await freshDb();
  const { cardId } = await seedCard(db, { used: 3, expiresAt: new Date(Date.now() - 1000) });

  const res = await punchCard(db, { punchCardId: cardId, method: 'qr_scan' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'expired');
});

test('inactive card is rejected', async () => {
  const db = await freshDb();
  const { cardId } = await seedCard(db, { isActive: false });

  const res = await punchCard(db, { punchCardId: cardId, method: 'qr_scan' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'inactive');
});

test('unknown card id is rejected as not_found and still audited', async () => {
  const db = await freshDb();

  const res = await punchCard(db, {
    punchCardId: '00000000-0000-0000-0000-000000000000',
    method: 'qr_scan',
    audit: { qrTokenHash: 'deadbeef' },
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'not_found');

  const audits = await db.select().from(scanAttempts);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.result, 'not_found');
});
