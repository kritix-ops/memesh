import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  getRoundSettings,
  updateRoundSettings,
  validateRoundSettingsPatch,
} from './round-settings';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

test('getRoundSettings returns the seeded defaults', async () => {
  const db = await freshDb();
  const s = await getRoundSettings(db);
  assert.equal(s.holdTtlMinutes, 15);
  assert.equal(s.cancellationWindowHours, 24);
  assert.equal(s.claimWindowMinutes, 60);
  assert.equal(s.bookingHorizonDays, 30);
  assert.equal(s.markingGraceMinutes, 30);
  assert.equal(s.manualRefundOnCancel, true);
  assert.equal(s.cancellationAlertEmail, '');
});

test('validateRoundSettingsPatch enforces ranges', () => {
  assert.equal(validateRoundSettingsPatch({ holdTtlMinutes: 0 })?.code, 'hold_ttl_out_of_range');
  assert.equal(validateRoundSettingsPatch({ holdTtlMinutes: 999 })?.code, 'hold_ttl_out_of_range');
  assert.equal(
    validateRoundSettingsPatch({ claimWindowMinutes: 0 })?.code,
    'claim_window_out_of_range',
  );
  assert.equal(
    validateRoundSettingsPatch({ cancellationWindowHours: -1 })?.code,
    'cancellation_window_out_of_range',
  );
  assert.equal(
    validateRoundSettingsPatch({ bookingHorizonDays: 0 })?.code,
    'booking_horizon_out_of_range',
  );
  assert.equal(
    validateRoundSettingsPatch({ bookingHorizonDays: 999 })?.code,
    'booking_horizon_out_of_range',
  );
  assert.equal(
    validateRoundSettingsPatch({ markingGraceMinutes: -1 })?.code,
    'marking_grace_out_of_range',
  );
  assert.equal(
    validateRoundSettingsPatch({ markingGraceMinutes: 999 })?.code,
    'marking_grace_out_of_range',
  );
  assert.equal(
    validateRoundSettingsPatch({ holdTtlMinutes: 20, cancellationWindowHours: 48 }),
    null,
  );
  assert.equal(validateRoundSettingsPatch({ bookingHorizonDays: 30 }), null);
  assert.equal(validateRoundSettingsPatch({ markingGraceMinutes: 0 }), null); // 0 = hard lock, valid
  assert.equal(
    validateRoundSettingsPatch({ cancellationAlertEmail: 'not-an-email' })?.code,
    'cancellation_alert_email_invalid',
  );
  assert.equal(validateRoundSettingsPatch({ cancellationAlertEmail: 'ops@memesh.co.il' }), null);
  assert.equal(validateRoundSettingsPatch({ cancellationAlertEmail: '' }), null); // clears the alert
  // Pre-visit reminder offsets (Yanay #11): up to 5, each 1-2880 min (48h).
  assert.equal(
    validateRoundSettingsPatch({ preVisitReminderOffsets: [0] })?.code,
    'pre_visit_reminder_offsets_invalid',
  );
  assert.equal(
    validateRoundSettingsPatch({ preVisitReminderOffsets: [3000] })?.code,
    'pre_visit_reminder_offsets_invalid',
  );
  assert.equal(validateRoundSettingsPatch({ preVisitReminderOffsets: [1440] }), null);
  assert.equal(validateRoundSettingsPatch({ preVisitReminderOffsets: [] }), null); // disables
});

test('updateRoundSettings persists the booking-notification fields', async () => {
  const db = await freshDb();
  // Defaults: confirmations on, pre-visit reminder 24h before start.
  const seed = await getRoundSettings(db);
  assert.equal(seed.bookingConfirmEmail, true);
  assert.equal(seed.bookingConfirmSms, true);
  assert.deepEqual(seed.preVisitReminderOffsets, [1440]);

  const res = await updateRoundSettings(db, {
    bookingConfirmSms: false,
    preVisitReminderOffsets: [1440, 120],
  });
  assert.equal(res.ok, true);
  const row = await getRoundSettings(db);
  assert.equal(row.bookingConfirmSms, false);
  assert.equal(row.bookingConfirmEmail, true); // untouched
  assert.deepEqual(row.preVisitReminderOffsets, [1440, 120]);
});

test('updateRoundSettings persists the manual-refund cancellation knobs', async () => {
  const db = await freshDb();
  const res = await updateRoundSettings(db, {
    manualRefundOnCancel: false,
    cancellationAlertEmail: 'ops@memesh.co.il',
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.manualRefundOnCancel, false);
  assert.equal(res.row.cancellationAlertEmail, 'ops@memesh.co.il');
  const reread = await getRoundSettings(db);
  assert.equal(reread.manualRefundOnCancel, false);
  assert.equal(reread.cancellationAlertEmail, 'ops@memesh.co.il');
});

test('updateRoundSettings persists bookingHorizonDays with a diff', async () => {
  const db = await freshDb();
  assert.equal((await getRoundSettings(db)).bookingHorizonDays, 30);
  const res = await updateRoundSettings(db, { bookingHorizonDays: 14 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.bookingHorizonDays, 14);
  assert.deepEqual(res.diff.bookingHorizonDays, [30, 14]);
  assert.equal((await getRoundSettings(db)).bookingHorizonDays, 14);
});

test('updateRoundSettings persists changes and reports a diff', async () => {
  const db = await freshDb();
  const res = await updateRoundSettings(db, { holdTtlMinutes: 20 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.holdTtlMinutes, 20);
  assert.deepEqual(res.diff.holdTtlMinutes, [15, 20]);
  assert.equal((await getRoundSettings(db)).holdTtlMinutes, 20);
});

test('updateRoundSettings rejects an invalid patch without writing', async () => {
  const db = await freshDb();
  const res = await updateRoundSettings(db, { holdTtlMinutes: 0 });
  assert.equal(res.ok, false);
  assert.equal((await getRoundSettings(db)).holdTtlMinutes, 15);
});

test('updateRoundSettings with an identical value returns an empty diff', async () => {
  const db = await freshDb();
  const res = await updateRoundSettings(db, { holdTtlMinutes: 15 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.diff, {});
});
