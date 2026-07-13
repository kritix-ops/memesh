// Interim manual-refund cancellation emails (Yanay 2026-07-13, "בינתיים"): when
// a customer cancels while the payment provider has no refund API, the seat is
// freed and TWO emails go out — a staff alert to refund by hand, and a customer
// confirmation. Fire-and-log: a mail failure never blocks the cancellation
// (the seat is already freed). Retire this path once auto-refund returns.
//
// The wording is admin-editable via the content registry (group email_cancel),
// resolved here with getMergedContent so Yanay's edits in "תוכן וטקסטים" drive
// the copy. The booking-details table is code-rendered (data, not copy).

import { resolveContent } from '@memesh/content';
import { getBookingNotifyDetails, getMergedContent, type BookingNotifyDetails } from '@memesh/db';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { FastifyBaseLogger } from 'fastify';
import { emailProvider } from './email.js';

type AnyPgDatabase = PgDatabase<any, any, any>;

const esc = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );

function layout(bodyHtml: string): string {
  return `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#2d3436;line-height:1.6;font-size:15px;max-width:520px;margin:0 auto;padding:8px">${bodyHtml}</div>`;
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:4px 0;color:#636e72;white-space:nowrap">${esc(label)}</td><td style="padding:4px 8px;font-weight:600">${esc(value)}</td></tr>`;
}

function paymentMethodHe(source: BookingNotifyDetails['source']): string {
  if (source === 'paid') return 'תשלום מקוון';
  if (source === 'punchcard') return 'כרטיסייה (מלווה בתשלום)';
  return source;
}

export interface FireCancellationEmailsInput {
  bookingId: string;
  /** The amount the customer should get back (drives whether staff are alerted). */
  refundAmountIls: number;
  /** Where the staff "refund by hand" alert goes; empty = skip that email. */
  alertEmail: string;
  log: FastifyBaseLogger;
}

/**
 * Send the manual-refund staff alert and the customer confirmation. Never
 * throws — each send is independently guarded so one failing doesn't stop the
 * other, and neither can undo the (already committed) cancellation.
 */
export async function fireCancellationEmails(
  db: AnyPgDatabase,
  input: FireCancellationEmailsInput,
): Promise<void> {
  const { bookingId, refundAmountIls, alertEmail, log } = input;
  let details: BookingNotifyDetails | null;
  try {
    details = await getBookingNotifyDetails(db, bookingId);
  } catch (err) {
    log.error({ err, bookingId }, '[cancel email] could not load booking details (non-fatal)');
    return;
  }
  if (!details) return;

  const content = await getMergedContent(db).catch(() => ({}));
  const t = (key: string, vars?: Record<string, string | number>): string =>
    resolveContent(content, key, vars);

  const fullName = `${details.customer.firstName} ${details.customer.lastName}`.trim();
  const when = `${details.date} · ${details.startTime}–${details.endTime}`;
  const bookingRef = details.bookingNumber ?? '—';

  // Staff alert — only when there's money to hand back and an inbox to send to.
  if (refundAmountIls > 0 && alertEmail) {
    try {
      const detailsTable = `<table style="border-collapse:collapse;margin:12px 0">${[
        row('לקוח/ה', fullName || '—'),
        row('טלפון', details.customer.phone),
        row('סבב', details.label),
        row('מועד', when),
        row('מספר הזמנה', bookingRef),
        row('סכום לזיכוי', `₪${refundAmountIls}`),
        row('אמצעי תשלום', paymentMethodHe(details.source)),
        row('מספר הזמנת WooCommerce', details.wcOrderId ?? '—'),
      ].join('')}</table>`;
      const html = layout(
        `<h2 style="font-size:18px;margin:0 0 6px">${esc(t('email.cancelStaff.heading'))}</h2>` +
          `<p style="margin:0 0 4px">${esc(t('email.cancelStaff.intro'))}</p>` +
          detailsTable,
      );
      const text =
        `${t('email.cancelStaff.heading')}\n${t('email.cancelStaff.intro')}\n\n` +
        `לקוח/ה: ${fullName} (${details.customer.phone})\n` +
        `סבב: ${details.label} · ${when}\n` +
        `מספר הזמנה: ${bookingRef}\n` +
        `סכום לזיכוי: ₪${refundAmountIls}\n` +
        `אמצעי תשלום: ${paymentMethodHe(details.source)}\n` +
        `הזמנת WooCommerce: ${details.wcOrderId ?? '—'}`;
      await emailProvider.send({ to: alertEmail, subject: t('email.cancelStaff.subject'), html, text });
      log.info({ bookingRef, alertEmail }, '[cancel email] staff alert sent');
    } catch (err) {
      log.error({ err, bookingRef }, '[cancel email] staff alert failed (non-fatal)');
    }
  } else if (refundAmountIls > 0) {
    log.warn(
      { bookingRef },
      '[cancel email] no cancellationAlertEmail configured — manual-refund alert not sent',
    );
  }

  // Customer confirmation — only when we have an address.
  if (details.customer.email) {
    try {
      const greeting = t('email.cancelCustomer.greeting', { name: details.customer.firstName || '' });
      const body = t('email.cancelCustomer.body', { round: details.label, when });
      const footer = t('email.cancelCustomer.footer');
      const html = layout(
        `<h2 style="font-size:18px;margin:0 0 6px">${esc(t('email.cancelCustomer.heading'))}</h2>` +
          `<p style="margin:0 0 8px">${esc(greeting)}</p>` +
          `<p style="margin:0 0 8px">${esc(body)}</p>` +
          `<p style="margin:0">${esc(footer)}</p>`,
      );
      const text = `${greeting}\n${body}\n${footer}`;
      await emailProvider.send({
        to: details.customer.email,
        subject: t('email.cancelCustomer.subject'),
        html,
        text,
      });
      log.info({ bookingRef }, '[cancel email] customer confirmation sent');
    } catch (err) {
      log.error({ err, bookingRef }, '[cancel email] customer confirmation failed (non-fatal)');
    }
  }
}
