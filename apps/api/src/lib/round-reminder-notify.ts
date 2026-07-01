import type { DueReminder } from '@memesh/db';
import type { FastifyBaseLogger } from 'fastify';
import { emailProvider } from './email.js';
import { smsProvider } from './sms.js';

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
        log.error({ err, roundInstanceId: reminder.roundInstanceId }, '[round reminder] email threw');
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
