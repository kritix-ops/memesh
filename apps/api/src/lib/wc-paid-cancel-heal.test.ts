import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  healChargedUnpaidOrders,
  type HealableStatus,
  type HealChargedUnpaidDeps,
} from './wc-paid-cancel-heal.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const LOOKBACK = 48;

// The exact meta shape the PayPlus plugin's callback left on order 6051 —
// present even though the order was never marked paid.
const approvedChargeMeta = (uid = 'fa1d93a3-b266-4408-a1e2-f0ae443b432f') => [
  { key: 'payplus_status', value: 'approved' },
  { key: 'payplus_status_code', value: '000' },
  { key: 'payplus_type', value: 'Charge' },
  { key: 'payplus_transaction_uid', value: uid },
];

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 6051,
  status: 'cancelled',
  total: '55',
  date_paid: null,
  date_modified_gmt: '2026-08-07T13:41:12',
  meta_data: approvedChargeMeta(),
  refunds: [],
  ...overrides,
});

// Fake deps: `byStatus` maps each fetched status to its order list; `paidCalls`
// records every heal write. `failWith` makes markOrderPaid throw per order id.
const fakeDeps = (
  byStatus: Partial<Record<HealableStatus, unknown[]>>,
  failWith: Record<number, string> = {},
) => {
  const paidCalls: Array<{ orderId: number; transactionUid: string }> = [];
  const deps: HealChargedUnpaidDeps = {
    listOrdersByStatusSince: async (status) => byStatus[status] ?? [],
    markOrderPaid: async (orderId, transactionUid) => {
      const failure = failWith[orderId];
      if (failure) throw new Error(failure);
      paidCalls.push({ orderId, transactionUid });
    },
  };
  return { deps, paidCalls };
};

test('heals a cancelled order carrying an approved PayPlus charge', async () => {
  const { deps, paidCalls } = fakeDeps({ cancelled: [order()] });
  const res = await healChargedUnpaidOrders(deps, { lookbackHours: LOOKBACK, now: NOW });

  assert.deepEqual(paidCalls, [
    { orderId: 6051, transactionUid: 'fa1d93a3-b266-4408-a1e2-f0ae443b432f' },
  ]);
  assert.equal(res.healed.length, 1);
  assert.deepEqual(res.healed[0], {
    orderId: 6051,
    status: 'cancelled',
    totalIls: '55',
    transactionUid: 'fa1d93a3-b266-4408-a1e2-f0ae443b432f',
  });
  assert.equal(res.ordersScanned, 1);
  assert.equal(res.failed.length, 0);
});

test('heals a charged pending order once past the grace window', async () => {
  // Modified 10 minutes ago — the plugin is definitively done with it.
  const stale = order({
    id: 6100,
    status: 'pending',
    date_modified_gmt: '2026-08-08T11:50:00',
  });
  const { deps, paidCalls } = fakeDeps({ pending: [stale] });
  const res = await healChargedUnpaidOrders(deps, { lookbackHours: LOOKBACK, now: NOW });

  assert.equal(paidCalls.length, 1);
  assert.equal(res.healed[0]?.orderId, 6100);
  assert.equal(res.skippedPendingGrace, 0);
});

test('grace-skips a charged pending order modified moments ago', async () => {
  const fresh = order({
    id: 6101,
    status: 'pending',
    date_modified_gmt: '2026-08-08T11:58:30',
  });
  const { deps, paidCalls } = fakeDeps({ pending: [fresh] });
  const res = await healChargedUnpaidOrders(deps, { lookbackHours: LOOKBACK, now: NOW });

  assert.equal(paidCalls.length, 0);
  assert.equal(res.healed.length, 0);
  assert.equal(res.skippedPendingGrace, 1);
});

test('cancelled orders get no grace window', async () => {
  // Cancelled seconds ago but cancellation is terminal — heal immediately.
  const justCancelled = order({ date_modified_gmt: '2026-08-08T11:59:50' });
  const { deps, paidCalls } = fakeDeps({ cancelled: [justCancelled] });
  await healChargedUnpaidOrders(deps, { lookbackHours: LOOKBACK, now: NOW });

  assert.equal(paidCalls.length, 1);
});

test('skips orders that are already paid, refunded, or not provably charged', async () => {
  const alreadyPaid = order({ id: 1, date_paid: '2026-08-07T12:35:24' });
  const refunded = order({ id: 2, refunds: [{ id: 9, total: '-55.00' }] });
  const declined = order({
    id: 3,
    meta_data: [
      { key: 'payplus_status', value: 'rejected' },
      { key: 'payplus_status_code', value: '053' },
      { key: 'payplus_type', value: 'Charge' },
      { key: 'payplus_transaction_uid', value: 'dead-uid' },
    ],
  });
  const authOnly = order({
    id: 4,
    meta_data: [
      { key: 'payplus_status', value: 'approved' },
      { key: 'payplus_status_code', value: '000' },
      { key: 'payplus_type', value: 'Approval' },
      { key: 'payplus_transaction_uid', value: 'auth-uid' },
    ],
  });
  const noUid = order({
    id: 5,
    meta_data: approvedChargeMeta().filter((m) => m.key !== 'payplus_transaction_uid'),
  });
  const neverCharged = order({ id: 6, meta_data: [] });

  const { deps, paidCalls } = fakeDeps({
    cancelled: [alreadyPaid, refunded, declined, authOnly, noUid, neverCharged],
  });
  const res = await healChargedUnpaidOrders(deps, { lookbackHours: LOOKBACK, now: NOW });

  assert.equal(paidCalls.length, 0);
  assert.equal(res.healed.length, 0);
  assert.equal(res.ordersScanned, 6);
  assert.equal(res.failed.length, 0);
});

test('a failed heal is recorded and does not block the other victims', async () => {
  const first = order({ id: 10 });
  const second = order({ id: 11 });
  const { deps, paidCalls } = fakeDeps(
    { cancelled: [first, second] },
    { 10: 'wc exploded: 500' },
  );
  const res = await healChargedUnpaidOrders(deps, { lookbackHours: LOOKBACK, now: NOW });

  assert.deepEqual(res.failed, [{ orderId: 10, error: 'wc exploded: 500' }]);
  assert.equal(paidCalls.length, 1);
  assert.equal(res.healed[0]?.orderId, 11);
});

test('scans both pending and cancelled with the lookback cutoff', async () => {
  const seen: Array<{ status: HealableStatus; since: string }> = [];
  const deps: HealChargedUnpaidDeps = {
    listOrdersByStatusSince: async (status, since) => {
      seen.push({ status, since: since.toISOString() });
      return [];
    },
    markOrderPaid: async () => {
      throw new Error('should not be called');
    },
  };
  const res = await healChargedUnpaidOrders(deps, { lookbackHours: 48, now: NOW });

  assert.deepEqual(seen, [
    { status: 'pending', since: '2026-08-06T12:00:00.000Z' },
    { status: 'cancelled', since: '2026-08-06T12:00:00.000Z' },
  ]);
  assert.equal(res.ordersScanned, 0);
  assert.equal(res.lookbackHours, 48);
});

test('malformed order payloads are skipped, not fatal', async () => {
  const { deps, paidCalls } = fakeDeps({
    cancelled: [null, 'garbage', { id: 'not-a-number' }, order()],
  });
  const res = await healChargedUnpaidOrders(deps, { lookbackHours: LOOKBACK, now: NOW });

  assert.equal(paidCalls.length, 1);
  assert.equal(res.healed[0]?.orderId, 6051);
});

test('a list fetch error propagates (cron reports the failure)', async () => {
  const deps: HealChargedUnpaidDeps = {
    listOrdersByStatusSince: async () => {
      throw new Error('wc down');
    },
    markOrderPaid: async () => {},
  };
  await assert.rejects(
    healChargedUnpaidOrders(deps, { lookbackHours: LOOKBACK, now: NOW }),
    /wc down/,
  );
});
