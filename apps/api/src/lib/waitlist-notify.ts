import type { PromotedEntry } from '@memesh/db';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';
import { emailProvider } from './email.js';
import { smsProvider } from './sms.js';

// Tell a promoted waitlist customer that a spot opened (super-brief §8.2).
// Transactional, not marketing — they opted into the waitlist and are waiting to
// hear — so it sends via the raw providers (no consent gate), and the engine
// only promotes inside active hours, so quiet hours are respected upstream.
// Best-effort: a failed notification must never break the promotion.

const VENUE_TZ = 'Asia/Jerusalem';

const claimTimeHhmm = (claimExpiresAt: Date): string =>
  new Intl.DateTimeFormat('he-IL', {
    timeZone: VENUE_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(claimExpiresAt);

export async function fireWaitlistOffer(entry: PromotedEntry, log: FastifyBaseLogger): Promise<void> {
  const until = claimTimeHhmm(entry.claimExpiresAt);
  const link = env.CUSTOMER_BASE_URL;
  const smsBody = `${entry.firstName}, התפנה מקום בסבב ${entry.startTime} (${entry.date}). יש לך עד ${until} לתפוס אותו באזור האישי: ${link}`;

  try {
    const res = await smsProvider.send({ to: entry.phone, body: smsBody });
    log.info({ entryId: entry.entryId, smsOk: res.ok }, '[waitlist notify] sms');
  } catch (err) {
    log.error({ err, entryId: entry.entryId }, '[waitlist notify] sms threw');
  }

  if (entry.email) {
    try {
      const res = await emailProvider.send({
        to: entry.email,
        subject: 'התפנה מקום בסבב במימש',
        text:
          `${entry.firstName}, שלום!\n\n` +
          `התפנה מקום בסבב ${entry.roundLabel} בשעה ${entry.startTime}–${entry.endTime} בתאריך ${entry.date}.\n` +
          `יש לך עד השעה ${until} לתפוס אותו — הזמינו את הכניסה באזור האישי:\n${link}\n\n` +
          `אם לא תתפסו בזמן, המקום יעבור לבא/ה בתור.`,
      });
      log.info({ entryId: entry.entryId, emailOk: res.ok }, '[waitlist notify] email');
    } catch (err) {
      log.error({ err, entryId: entry.entryId }, '[waitlist notify] email threw');
    }
  }
}
