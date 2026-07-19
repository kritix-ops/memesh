import type { DueReminder } from '@memesh/db';
import type { FastifyBaseLogger } from 'fastify';
import { emailProvider } from './email.js';
import { smsProvider } from './sms.js';

type ContentFn = (key: string, vars?: Record<string, string | number>) => string;

/** YYYY-MM-DD → DD.MM.YYYY for customer-facing copy (matches Yanay's examples). */
const fmtHeDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
};

// Send one stay-duration reminder batch (super-brief §9). Transactional — the
// customer booked and this is a service reminder about their own round — so it
// goes via the raw providers with no consent gate. Best-effort: a failed send
// never fails the cron. Returns the count of SMS actually accepted.
export async function fireRoundReminder(
  reminder: DueReminder,
  log: FastifyBaseLogger,
): Promise<number> {
  const smsBody = `תזכורת: הסבב שלכם (${reminder.startTime}–${reminder.endTime}) מסתיים בעוד ${reminder.offsetMinutes} דקות.`;
  let sent = 0;

  for (const r of reminder.recipients) {
    try {
      const res = await smsProvider.send({ to: r.phone, body: smsBody });
      if (res.ok) sent += 1;
    } catch (err) {
      log.error({ err, roundInstanceId: reminder.roundInstanceId }, '[round reminder] sms threw');
    }
    if (r.email) {
      try {
        await emailProvider.send({
          to: r.email,
          subject: 'הסבב שלכם מסתיים בקרוב',
          text:
            `${r.firstName}, שלום!\n\n` +
            `הסבב שלכם (${reminder.roundLabel}, ${reminder.startTime}–${reminder.endTime}) ` +
            `מסתיים בעוד ${reminder.offsetMinutes} דקות.\n\nמקווים שנהניתם!`,
        });
      } catch (err) {
        log.error(
          { err, roundInstanceId: reminder.roundInstanceId },
          '[round reminder] email threw',
        );
      }
    }
  }

  log.info(
    {
      roundInstanceId: reminder.roundInstanceId,
      offset: reminder.offsetMinutes,
      recipients: reminder.recipients.length,
      smsSent: sent,
    },
    '[round reminder] batch sent',
  );
  return sent;
}

// Send one pre-visit reminder batch (Yanay #11) — the "מחכים לכם מחר" nudge before
// the round starts. Same transactional, best-effort contract as the stay-duration
// reminder, but the copy is admin-editable (group booking_notify), resolved by the
// cron and passed in as `t`. Returns the count of SMS actually accepted.
export async function firePreVisitReminder(
  reminder: DueReminder,
  t: ContentFn,
  log: FastifyBaseLogger,
): Promise<number> {
  const time = `${reminder.startTime}–${reminder.endTime}`;
  const smsBody = t('notify.preVisit.smsBody', { time, end: reminder.endTime });
  let sent = 0;

  for (const r of reminder.recipients) {
    try {
      const res = await smsProvider.send({ to: r.phone, body: smsBody });
      if (res.ok) sent += 1;
    } catch (err) {
      log.error(
        { err, roundInstanceId: reminder.roundInstanceId },
        '[previsit reminder] sms threw',
      );
    }
    if (r.email) {
      try {
        const vars = {
          name: r.firstName || '',
          date: fmtHeDate(reminder.date),
          time,
          end: reminder.endTime,
        };
        await emailProvider.send({
          to: r.email,
          subject: t('notify.preVisit.emailSubject'),
          text: `${t('notify.preVisit.emailGreeting', vars)}\n\n${t('notify.preVisit.emailBody', vars)}`,
        });
      } catch (err) {
        log.error(
          { err, roundInstanceId: reminder.roundInstanceId },
          '[previsit reminder] email threw',
        );
      }
    }
  }

  log.info(
    {
      roundInstanceId: reminder.roundInstanceId,
      offset: reminder.offsetMinutes,
      recipients: reminder.recipients.length,
      smsSent: sent,
    },
    '[previsit reminder] batch sent',
  );
  return sent;
}
