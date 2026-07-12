import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  createStaff,
  deleteCustomer,
  getCustomerById,
  getStaffByEmailWithSecret,
  getStaffById,
  listStaff,
  setCustomerWpUserId,
  setStaffPasswordHash,
  updateCustomerPhone,
  updateCustomerProfile,
  updateStaff,
} from './accounts';
import { cancelCard, createCustomer, createPunchCard } from './cards';
import { punchCardEntries, punchCards } from './schema/index';
import { eq } from 'drizzle-orm';
import type { KeyResolver } from '@memesh/qr-engine';

// Test signing key. Just enough surface for createPunchCard to mint a token.
const TEST_SECRET = 'test-secret-that-is-at-least-32-characters';
const resolver: KeyResolver = {
  resolveSigningKey: () => ({ keyId: 'test-key', secret: TEST_SECRET }),
  resolveVerifyKey: (keyId) => (keyId === 'test-key' ? TEST_SECRET : undefined),
};

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

let seq = 0;
const phone = () => {
  seq += 1;
  return `050-700-${String(seq).padStart(4, '0')}`;
};

test('createStaff stores a member and never returns the password hash', async () => {
  const db = await freshDb();
  const created = await createStaff(db, {
    firstName: 'Maya',
    lastName: 'Barak',
    phone: phone(),
    passwordHash: 'scrypt$32768$8$1$abc$def',
    role: 'manager',
  });
  assert.equal(created.role, 'manager');
  assert.equal(created.isActive, true);
  assert.equal('passwordHash' in created, false);
});

test('listStaff returns members without password hashes', async () => {
  const db = await freshDb();
  await createStaff(db, {
    firstName: 'Shani',
    lastName: 'Dahan',
    phone: phone(),
    passwordHash: 'scrypt$1$2$3$x$y',
    role: 'cashier',
  });
  const all = await listStaff(db);
  assert.equal(all.length, 1);
  assert.equal('passwordHash' in (all[0] ?? {}), false);
});

test('getStaffById returns the public view (no password hash) for a known id', async () => {
  const db = await freshDb();
  const created = await createStaff(db, {
    firstName: 'Lior',
    lastName: 'Avraham',
    phone: phone(),
    passwordHash: 'scrypt$1$2$3$abc$def',
    role: 'manager',
  });
  const found = await getStaffById(db, created.id);
  assert.ok(found);
  assert.equal(found.id, created.id);
  assert.equal(found.firstName, 'Lior');
  assert.equal(found.lastName, 'Avraham');
  assert.equal(found.role, 'manager');
  assert.equal(found.isActive, true);
  assert.equal('passwordHash' in found, false);
});

test('getStaffById returns undefined for an unknown id', async () => {
  const db = await freshDb();
  const missing = await getStaffById(db, '00000000-0000-0000-0000-000000000000');
  assert.equal(missing, undefined);
});

test('updateStaff patches editable fields and returns the safe view', async () => {
  const db = await freshDb();
  const created = await createStaff(db, {
    firstName: 'Old',
    lastName: 'Name',
    phone: phone(),
    passwordHash: 'scrypt$1$2$3$x$y',
    role: 'cashier',
  });

  const updated = await updateStaff(db, created.id, {
    firstName: 'New',
    lastName: 'Surname',
    role: 'manager',
    email: 'new@example.com',
  });
  assert.ok(updated);
  assert.equal(updated.firstName, 'New');
  assert.equal(updated.lastName, 'Surname');
  assert.equal(updated.role, 'manager');
  assert.equal(updated.email, 'new@example.com');
  assert.equal('passwordHash' in updated, false);
});

test('updateStaff can flip isActive (deactivate / reactivate)', async () => {
  const db = await freshDb();
  const created = await createStaff(db, {
    firstName: 'A',
    lastName: 'B',
    phone: phone(),
    passwordHash: 'scrypt$1$2$3$x$y',
  });
  assert.equal(created.isActive, true);

  const deactivated = await updateStaff(db, created.id, { isActive: false });
  assert.equal(deactivated?.isActive, false);

  const reactivated = await updateStaff(db, created.id, { isActive: true });
  assert.equal(reactivated?.isActive, true);
});

test('updateStaff returns undefined for an unknown id', async () => {
  const db = await freshDb();
  const missing = await updateStaff(db, '00000000-0000-0000-0000-000000000000', {
    firstName: 'X',
  });
  assert.equal(missing, undefined);
});

test('getStaffByEmailWithSecret matches case-insensitively and returns the password hash', async () => {
  const db = await freshDb();
  const created = await createStaff(db, {
    firstName: 'Email',
    lastName: 'User',
    phone: phone(),
    passwordHash: 'scrypt$32768$8$1$abc$def',
    role: 'admin',
    email: 'Owner@Example.COM',
  });

  const found = await getStaffByEmailWithSecret(db, 'owner@example.com');
  assert.ok(found);
  assert.equal(found.id, created.id);
  assert.equal(found.passwordHash, 'scrypt$32768$8$1$abc$def');

  const sameCase = await getStaffByEmailWithSecret(db, 'OWNER@EXAMPLE.COM');
  assert.equal(sameCase?.id, created.id);
});

test('getStaffByEmailWithSecret returns undefined for unknown and empty inputs', async () => {
  const db = await freshDb();
  assert.equal(await getStaffByEmailWithSecret(db, 'nobody@example.com'), undefined);
  assert.equal(await getStaffByEmailWithSecret(db, ''), undefined);
  assert.equal(await getStaffByEmailWithSecret(db, '   '), undefined);
});

test('setStaffPasswordHash rotates only the password hash', async () => {
  const db = await freshDb();
  const created = await createStaff(db, {
    firstName: 'Rotate',
    lastName: 'Me',
    phone: phone(),
    passwordHash: 'scrypt$old',
    role: 'manager',
    email: 'rotate@example.com',
  });

  const result = await setStaffPasswordHash(db, created.id, 'scrypt$new');
  assert.equal(result?.id, created.id);

  const after = await getStaffByEmailWithSecret(db, 'rotate@example.com');
  assert.equal(after?.passwordHash, 'scrypt$new');
});

test('updateCustomerProfile edits allowed fields and leaves phone unchanged', async () => {
  const db = await freshDb();
  const p = phone();
  const customer = await createCustomer(db, { firstName: 'Noa', lastName: 'Cohen', phone: p });

  const updated = await updateCustomerProfile(db, customer.id, {
    firstName: 'Noa-Updated',
    email: 'noa@example.com',
    preferredChannel: 'whatsapp',
    children: [{ name: 'Itamar', dob: '2021-04-12' }],
  });

  assert.ok(updated);
  assert.equal(updated.firstName, 'Noa-Updated');
  assert.equal(updated.email, 'noa@example.com');
  assert.equal(updated.preferredChannel, 'whatsapp');
  assert.equal(updated.children.length, 1);
  assert.equal(updated.phone, p); // phone is not editable here
});

test('updateCustomerPhone changes the number and touches nothing else', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Rina',
    lastName: 'Barak',
    phone: '050-111-1111',
    email: 'rina@example.com',
  });

  const res = await updateCustomerPhone(db, customer.id, '050-222-2222');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.changed, true);
    assert.equal(res.customer.phone, '050-222-2222');
    assert.equal(res.customer.email, 'rina@example.com'); // unrelated fields intact
  }
  const reread = await getCustomerById(db, customer.id);
  assert.equal(reread?.phone, '050-222-2222');
});

test('updateCustomerPhone with the same number is a no-op (changed:false)', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Same',
    lastName: 'Number',
    phone: '050-333-3333',
  });

  const res = await updateCustomerPhone(db, customer.id, '050-333-3333');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.changed, false);
    assert.equal(res.customer.phone, '050-333-3333');
  }
});

test('updateCustomerPhone rejects a number already owned by another customer', async () => {
  const db = await freshDb();
  const a = await createCustomer(db, { firstName: 'A', lastName: 'One', phone: '050-444-4444' });
  await createCustomer(db, { firstName: 'B', lastName: 'Two', phone: '050-555-5555' });

  const res = await updateCustomerPhone(db, a.id, '050-555-5555');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'phone_taken');
  // A keeps its original number — the failed update did not partially apply.
  const reread = await getCustomerById(db, a.id);
  assert.equal(reread?.phone, '050-444-4444');
});

test('updateCustomerPhone on an unknown id → not_found', async () => {
  const db = await freshDb();
  const res = await updateCustomerPhone(db, '00000000-0000-0000-0000-000000000000', '050-666-6666');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'not_found');
});

test('setCustomerWpUserId links a customer to a WordPress user id', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Dana',
    lastName: 'Levi',
    phone: phone(),
  });
  assert.equal(customer.wpUserId, null);
  const linked = await setCustomerWpUserId(db, customer.id, 4242);
  assert.equal(linked?.wpUserId, 4242);
});

test('getCustomerById returns the customer or undefined', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Tamar',
    lastName: 'Levi',
    phone: phone(),
  });
  const found = await getCustomerById(db, customer.id);
  assert.ok(found);
  assert.equal(found.id, customer.id);
  const missing = await getCustomerById(db, '00000000-0000-0000-0000-000000000000');
  assert.equal(missing, undefined);
});

// ---------------------------------------------------------------------------
// deleteCustomer — cancellation-gated cascade
//
// Yanay bug report 2026-06-22: cancelling a customer's card and then trying
// to delete the customer would fail with `has_dependents` because the raw
// DELETE was blocked by the punch_cards FK regardless of cancellation
// state. After the fix, cancelled cards no longer block — only ACTIVE
// (cancelledAt IS NULL) cards do.
// ---------------------------------------------------------------------------

test('deleteCustomer: customer with no cards → ok, customer row gone', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Avi',
    lastName: 'Cohen',
    phone: phone(),
  });
  const res = await deleteCustomer(db, customer.id);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.id, customer.id);
  assert.equal(await getCustomerById(db, customer.id), undefined);
});

test('deleteCustomer: unknown id → not_found', async () => {
  const db = await freshDb();
  const res = await deleteCustomer(db, '00000000-0000-0000-0000-000000000000');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'not_found');
});

test('deleteCustomer: one ACTIVE card → has_active_cards (count=1), customer preserved', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Noa',
    lastName: 'Levi',
    phone: phone(),
  });
  await createPunchCard(db, resolver, { customerId: customer.id });

  const res = await deleteCustomer(db, customer.id);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'has_active_cards');
    if (res.reason === 'has_active_cards') {
      assert.equal(res.activeCount, 1);
    }
  }
  // Customer + card both still there — the block is a soft check, no writes.
  assert.ok(await getCustomerById(db, customer.id));
  const cards = await db.select().from(punchCards).where(eq(punchCards.customerId, customer.id));
  assert.equal(cards.length, 1);
});

test('deleteCustomer: ALL cards cancelled → ok, customer + cards cascade-deleted', async () => {
  // The bug Yanay reported: this case used to throw an FK violation. After
  // the fix it succeeds and the cards are gone too.
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Yoav',
    lastName: 'Mizrachi',
    phone: phone(),
  });
  const card = await createPunchCard(db, resolver, { customerId: customer.id });
  const cancelRes = await cancelCard(db, {
    cardId: card.id,
    reason: 'test cancellation for delete flow',
  });
  assert.equal(cancelRes.ok, true);

  const res = await deleteCustomer(db, customer.id);
  assert.equal(res.ok, true);

  assert.equal(await getCustomerById(db, customer.id), undefined);
  const cards = await db.select().from(punchCards).where(eq(punchCards.customerId, customer.id));
  assert.equal(cards.length, 0, 'cancelled card must be cascade-deleted with the customer');
});

test('deleteCustomer: cancelled card with entries → entries also wiped (FK respected)', async () => {
  // The cascade chain is entries → cards → customer. Without wiping entries
  // first the FK on punch_card_entries.punch_card_id would block the card
  // delete, which would in turn block the customer delete.
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Maya',
    lastName: 'Adar',
    phone: phone(),
  });
  const card = await createPunchCard(db, resolver, { customerId: customer.id });

  // Insert a punch entry directly. We don't need the full punchCard()
  // domain logic here — the cascade behavior is independent of how the
  // entry got there.
  await db.insert(punchCardEntries).values({
    punchCardId: card.id,
    method: 'manual',
    entriesConsumed: 1,
  });

  await cancelCard(db, {
    cardId: card.id,
    reason: 'cancel after a punch was recorded',
  });

  const res = await deleteCustomer(db, customer.id);
  assert.equal(res.ok, true);

  // All three rows gone in one transaction.
  assert.equal(await getCustomerById(db, customer.id), undefined);
  const cards = await db.select().from(punchCards).where(eq(punchCards.customerId, customer.id));
  assert.equal(cards.length, 0);
  const entries = await db
    .select()
    .from(punchCardEntries)
    .where(eq(punchCardEntries.punchCardId, card.id));
  assert.equal(entries.length, 0);
});

test('deleteCustomer: mix of active + cancelled cards → block, count only the active', async () => {
  const db = await freshDb();
  const customer = await createCustomer(db, {
    firstName: 'Tal',
    lastName: 'Bar',
    phone: phone(),
  });
  const cancelled = await createPunchCard(db, resolver, { customerId: customer.id });
  await cancelCard(db, { cardId: cancelled.id, reason: 'cancel one card only' });
  // Second card stays active.
  await createPunchCard(db, resolver, { customerId: customer.id });

  const res = await deleteCustomer(db, customer.id);
  assert.equal(res.ok, false);
  if (!res.ok && res.reason === 'has_active_cards') {
    assert.equal(res.activeCount, 1, 'only the non-cancelled card is counted');
  } else {
    assert.fail(`expected has_active_cards, got ${JSON.stringify(res)}`);
  }

  // Defensive: the cancelled card was NOT deleted by the failed attempt.
  // (The block must be a no-op write-wise.)
  const cards = await db.select().from(punchCards).where(eq(punchCards.customerId, customer.id));
  assert.equal(cards.length, 2);
});
