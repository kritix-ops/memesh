import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { listStaffActions } from './actions';
import { getCardSettings, isQuietHourNow, updateCardSettings } from './card-settings';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder: './migrations' });
  return db;
}

test('getCardSettings returns the seeded singleton with defaults', async () => {
  const db = await freshDb();
  const s = await getCardSettings(db);
  assert.equal(s.priceShekels, 320);
  assert.equal(s.validityDays, 365);
  assert.equal(s.totalEntries, 12);
  assert.equal(s.pitchLabel, 'משלמים על 10, מקבלים 12 · תקף לשנה');
  assert.equal(s.singleton, true);
});

test('getCardSettings is idempotent: a second call returns the same row', async () => {
  const db = await freshDb();
  const a = await getCardSettings(db);
  const b = await getCardSettings(db);
  assert.equal(a.id, b.id);
});

test('updateCardSettings persists changed fields and returns a diff', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { priceShekels: 350, totalEntries: 10 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.priceShekels, 350);
  assert.equal(res.row.totalEntries, 10);
  // Unchanged fields stay at their defaults.
  assert.equal(res.row.validityDays, 365);
  assert.deepEqual(res.diff.priceShekels, [320, 350]);
  assert.deepEqual(res.diff.totalEntries, [12, 10]);
});

test('updateCardSettings trims pitch label and records the change', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { pitchLabel: '  כרטיסייה משתלמת · 12 כניסות  ' });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.pitchLabel, 'כרטיסייה משתלמת · 12 כניסות');
});

test('updateCardSettings rejects out-of-range price', async () => {
  const db = await freshDb();
  const tooHigh = await updateCardSettings(db, { priceShekels: 99999 });
  assert.equal(tooHigh.ok, false);
  if (!tooHigh.ok) assert.equal(tooHigh.error, 'price_out_of_range');
  const negative = await updateCardSettings(db, { priceShekels: -1 });
  assert.equal(negative.ok, false);
  if (!negative.ok) assert.equal(negative.error, 'price_out_of_range');
});

test('updateCardSettings rejects validity > 3650 and entries 0', async () => {
  const db = await freshDb();
  // validityDays=0 is now the "forever" sentinel, so it must be accepted.
  // Test the upper bound instead.
  const v = await updateCardSettings(db, { validityDays: 99999 });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.error, 'validity_out_of_range');
  const e = await updateCardSettings(db, { totalEntries: 0 });
  assert.equal(e.ok, false);
  if (!e.ok) assert.equal(e.error, 'entries_out_of_range');
});

test('updateCardSettings rejects empty pitch label after trim', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { pitchLabel: '   ' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'pitch_length');
});

test('updateCardSettings returns no_changes when patch is a no-op', async () => {
  const db = await freshDb();
  // Default price is 320; sending the same value should not log.
  const res = await updateCardSettings(db, { priceShekels: 320 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'no_changes');
  const actions = await listStaffActions(db);
  assert.equal(actions.filter((a) => a.action === 'update_card_settings').length, 0);
});

test('updateCardSettings logs a staff action with a Hebrew diff summary', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { priceShekels: 340, totalEntries: 10 });
  assert.equal(res.ok, true);
  const actions = await listStaffActions(db);
  const entry = actions.find((a) => a.action === 'update_card_settings');
  assert.ok(entry, 'expected update_card_settings action to be logged');
  assert.match(entry!.summary, /מחיר 320→340/);
  assert.match(entry!.summary, /כניסות 12→10/);
});

// ---------------------------------------------------------------------------
// Expanded settings — lockout, grace, cancel, SMS, customer.
// ---------------------------------------------------------------------------

test('updateCardSettings rejects lockout > 1440 minutes', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { sameDayLockoutMinutes: 5000 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'lockout_out_of_range');
});

test('updateCardSettings rejects grace > 90 days', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { gracePeriodDays: 365 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'grace_out_of_range');
});

test('updateCardSettings rejects an unknown cancel role', async () => {
  const db = await freshDb();
  // @ts-expect-error testing runtime validation
  const res = await updateCardSettings(db, { cancelRole: 'cashier' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'cancel_role_invalid');
});

test('updateCardSettings accepts valid cancel roles', async () => {
  const db = await freshDb();
  const a = await updateCardSettings(db, { cancelRole: 'admin' });
  assert.equal(a.ok, true);
  const m = await updateCardSettings(db, { cancelRole: 'manager' });
  assert.equal(m.ok, true);
});

test('updateCardSettings preserves whitespace in refund policy text', async () => {
  const db = await freshDb();
  const txt = 'מדיניות החזרים:\n\n1. עד 24 שעות לפני המכירה.\n2. החזר מלא.';
  const res = await updateCardSettings(db, { refundPolicyText: txt });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.refundPolicyText, txt);
});

test('updateCardSettings rejects refund policy > 2000 chars', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, { refundPolicyText: 'x'.repeat(2001) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, 'refund_policy_too_long');
});

test('updateCardSettings rejects sms quiet hours outside 0–1439', async () => {
  const db = await freshDb();
  const a = await updateCardSettings(db, { smsQuietStartMinutes: 1500 });
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.error, 'sms_quiet_minutes_out_of_range');
});

test('updateCardSettings toggles every new boolean independently', async () => {
  const db = await freshDb();
  const res = await updateCardSettings(db, {
    allowCancelAfterFirstPunch: false,
    smsOnPurchase: false,
    requireEmailOnNewCustomer: true,
    requireChildOnNewCustomer: true,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.row.allowCancelAfterFirstPunch, false);
  assert.equal(res.row.smsOnPurchase, false);
  assert.equal(res.row.requireEmailOnNewCustomer, true);
  assert.equal(res.row.requireChildOnNewCustomer, true);
});

// ---------------------------------------------------------------------------
// isQuietHourNow — non-wrapping + wrapping windows + zero-width.
// ---------------------------------------------------------------------------

// Build an instant whose Asia/Jerusalem clock reads exactly HH:MM. Because
// Israel observes DST we use Intl to back-calculate the UTC instant that
// formats to the target time.
function jerusalemInstant(hh: number, mm: number, dateLabel = '2026-06-20'): Date {
  // June is IDT (UTC+3). Easy enough for tests — pick a date in DST so the
  // offset is stable. UTC = local - 3h.
  const utcH = (hh - 3 + 24) % 24;
  return new Date(`${dateLabel}T${String(utcH).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
}

test('isQuietHourNow: non-wrapping window includes start, excludes end', () => {
  // Quiet 10:00 → 12:00. 10:00 in, 11:30 in, 12:00 out (excluded), 09:59 out.
  assert.equal(isQuietHourNow(600, 720, jerusalemInstant(10, 0)), true);
  assert.equal(isQuietHourNow(600, 720, jerusalemInstant(11, 30)), true);
  assert.equal(isQuietHourNow(600, 720, jerusalemInstant(12, 0)), false);
  assert.equal(isQuietHourNow(600, 720, jerusalemInstant(9, 59)), false);
});

test('isQuietHourNow: wrapping window (21:00 → 09:00) covers night across midnight', () => {
  // Quiet 21:00 → 09:00. 22:00 in, 02:00 in, 09:00 out, 12:00 out, 20:59 out, 21:00 in.
  assert.equal(isQuietHourNow(1260, 540, jerusalemInstant(22, 0)), true);
  assert.equal(isQuietHourNow(1260, 540, jerusalemInstant(2, 0)), true);
  assert.equal(isQuietHourNow(1260, 540, jerusalemInstant(9, 0)), false);
  assert.equal(isQuietHourNow(1260, 540, jerusalemInstant(12, 0)), false);
  assert.equal(isQuietHourNow(1260, 540, jerusalemInstant(20, 59)), false);
  assert.equal(isQuietHourNow(1260, 540, jerusalemInstant(21, 0)), true);
});

test('isQuietHourNow: zero-width window is always off', () => {
  assert.equal(isQuietHourNow(600, 600, jerusalemInstant(10, 0)), false);
  assert.equal(isQuietHourNow(0, 0, jerusalemInstant(0, 0)), false);
});

// ---------------------------------------------------------------------------
// Cashier anti-fraud + editable copy (Yanay 2026-06-20)
// ---------------------------------------------------------------------------

test('getCardSettings ships with anti-fraud defaults all on and Hebrew copy filled in', async () => {
  const db = await freshDb();
  const s = await getCardSettings(db);
  assert.equal(s.requireReceiptNumberOnPos, true);
  assert.equal(s.requireSellerPin, true);
  assert.equal(s.pinLength, 3);
  assert.equal(s.pinMemoryMinutes, 15);
  assert.equal(s.pinMaxFailures, 5);
  assert.equal(s.pinLockoutMinutes, 15);
  assert.match(s.posNameOnReceiptLabel, /שם הלקוח/);
  assert.match(s.posEmailNudgeText, /אימייל/);
  assert.match(s.emailOtpSubject, /קוד/);
  assert.match(s.emailOtpBodyTemplate, /\{\{code\}\}/);
});

test('updateCardSettings validates PIN ranges + rejects unknown email template placeholders', async () => {
  const db = await freshDb();
  const a = await updateCardSettings(db, { pinLength: 1 });
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.error, 'pin_length_out_of_range');

  const b = await updateCardSettings(db, { pinMaxFailures: 11 });
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.error, 'pin_max_failures_out_of_range');

  // {{name}} is not a known placeholder — refuse rather than silently break OTPs.
  const c = await updateCardSettings(db, {
    emailOtpBodyTemplate: 'שלום {{name}}, הקוד הוא {{code}}',
  });
  assert.equal(c.ok, false);
  if (!c.ok) assert.equal(c.error, 'email_otp_body_template_unknown_placeholder');

  // Valid edit goes through.
  const d = await updateCardSettings(db, {
    emailOtpBodyTemplate: 'שלום {{firstName}}, הקוד הוא {{code}}',
    pinLength: 4,
  });
  assert.equal(d.ok, true);
});

test('updateCardSettings validates checkout thank-you copy + placeholders', async () => {
  const db = await freshDb();

  // Title supports {{firstName}} but rejects unknown tokens.
  const badTitle = await updateCardSettings(db, {
    checkoutThankyouTitle: 'שלום {{nickname}}',
  });
  assert.equal(badTitle.ok, false);
  if (!badTitle.ok) assert.equal(badTitle.error, 'checkout_thankyou_title_unknown_placeholder');

  const badBody = await updateCardSettings(db, {
    checkoutThankyouBody: 'תודה {{name}}!',
  });
  assert.equal(badBody.ok, false);
  if (!badBody.ok) assert.equal(badBody.error, 'checkout_thankyou_body_unknown_placeholder');

  const emptyButton = await updateCardSettings(db, { checkoutThankyouButtonText: '   ' });
  assert.equal(emptyButton.ok, false);
  if (!emptyButton.ok) assert.equal(emptyButton.error, 'checkout_thankyou_button_text_length');

  // Valid edit with {{firstName}} in title and a multi-line body goes through.
  const ok = await updateCardSettings(db, {
    checkoutThankyouTitle: 'תודה רבה, {{firstName}}!',
    checkoutThankyouBody: 'הכרטיסייה שלך מוכנה.\nנשמח לראותך בקרוב.',
    checkoutThankyouButtonText: 'לאזור האישי',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.row.checkoutThankyouTitle, 'תודה רבה, {{firstName}}!');
  assert.equal(ok.row.checkoutThankyouBody, 'הכרטיסייה שלך מוכנה.\nנשמח לראותך בקרוב.');
  assert.equal(ok.row.checkoutThankyouButtonText, 'לאזור האישי');
});
