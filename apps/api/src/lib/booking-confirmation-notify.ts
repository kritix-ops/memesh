// Booking-confirmation email + SMS, sent the moment a round booking is
// confirmed (Yanay #10). Transactional — the customer just booked their own
// round — so it goes via the raw providers with no marketing-consent or
// quiet-hours gate, same as the round reminders. Fire-and-log: a send failure
// never fails the booking (the seat is already reserved).
//
// The wording is admin-editable via the content registry (group booking_notify),
// resolved with getMergedContent so Yanay's edits in "תוכן וטקסטים" drive the
// copy. The two channels are independently toggled in round_settings so the paid
// SMS can be turned off while the free email stays on.

import { resolveContent } from '@memesh/content';
import {
  getBookingNotifyDetails,
  getMergedContent,
  getRoundSettings,
  type BookingNotifyDetails,
} from '@memesh/db';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { FastifyBaseLogger } from 'fastify';
import { emailProvider } from './email.js';
import { smsProvider } from './sms.js';

type AnyPgDatabase = PgDatabase<any, any, any>;

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

const layout = (bodyHtml: string): string =>
  `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#2d3436;line-height:1.6;font-size:15px;max-width:520px;margin:0 auto;padding:8px">${bodyHtml}</div>`;

/** YYYY-MM-DD → DD.MM.YYYY for customer-facing copy (matches Yanay's examples). */
const fmtHeDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
};

export interface FireBookingConfirmationInput {
  bookingId: string;
  log: FastifyBaseLogger;
}

/**
 * Send the booking-confirmation email and SMS for one confirmed booking. A
 * multi-entry punch booking is a single visit for one customer, so the caller
 * passes ONE booking id (the others share round/date/customer) — one message,
 * not one per child. Never throws; each channel is independently guarded.
 */
export async function fireBookingConfirmation(
  db: AnyPgDatabase,
  input: FireBookingConfirmationInput,
): Promise<void> {
  const { bookingId, log } = input;

  let details: BookingNotifyDetails | null;
  try {
    details = await getBookingNotifyDetails(db, bookingId);
  } catch (err) {
    log.error({ err, bookingId }, '[booking confirm] could not load details (non-fatal)');
    return;
  }
  if (!details) return;

  const settings = await getRoundSettings(db).catch(() => null);
  const wantEmail = settings?.bookingConfirmEmail ?? true;
  const wantSms = settings?.bookingConfirmSms ?? true;
  if (!wantEmail && !wantSms) return;

  const content = await getMergedContent(db).catch(() => ({}));
  const t = (key: string, vars?: Record<string, string | number>): string =>
    resolveContent(content, key, vars);

  const vars = {
    name: details.customer.firstName || '',
    date: fmtHeDate(details.date),
    time: `${details.startTime}–${details.endTime}`,
  };
  const bookingRef = details.bookingNumber ?? bookingId;

  // SMS — transactional, sent directly. Only when a phone is on file (walk-in
  // sentinels never reach here — this path is the customer's own punch booking).
  if (wantSms && details.customer.phone) {
    try {
      const res = await smsProvider.send({
        to: details.customer.phone,
        body: t('notify.confirm.smsBody', vars),
      });
      if (res.ok) log.info({ bookingRef }, '[booking confirm] sms sent');
      else log.warn({ bookingRef, error: res.error }, '[booking confirm] sms provider error');
    } catch (err) {
      log.error({ err, bookingRef }, '[booking confirm] sms threw (non-fatal)');
    }
  }

  // Email — free channel; only when we have an address.
  if (wantEmail && details.customer.email) {
    try {
      const greeting = t('notify.confirm.emailGreeting', vars);
      const body = t('notify.confirm.emailBody', vars);
      const footer = t('notify.confirm.emailFooter');
      const html = layout(
        `<h2 style="font-size:18px;margin:0 0 6px">${esc(t('notify.confirm.emailHeading'))}</h2>` +
          `<p style="margin:0 0 8px">${esc(greeting)}</p>` +
          `<p style="margin:0 0 8px;white-space:pre-line">${esc(body)}</p>` +
          `<p style="margin:0">${esc(footer)}</p>`,
      );
      const text = `${greeting}\n${body}\n${footer}`;
      await emailProvider.send({
        to: details.customer.email,
        subject: t('notify.confirm.emailSubject'),
        html,
        text,
      });
      log.info({ bookingRef }, '[booking confirm] email sent');
    } catch (err) {
      log.error({ err, bookingRef }, '[booking confirm] email failed (non-fatal)');
    }
  }
}
