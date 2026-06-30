/**
 * Gift card claim flow. Three endpoints, all unauthenticated (the claim
 * token IS the auth):
 *
 *   GET  /auth/customer/gift/preview/:claimToken
 *     Return the gift summary (buyer first name + card teaser) so the claim
 *     page can render before the recipient enters anything. Does NOT consume
 *     the token. Rate-limited to slow guessing.
 *
 *   POST /auth/customer/gift/request-otp
 *     Body: { claimToken, phone }. Validates that (a) the token is live,
 *     (b) the recipient phone on the pending row matches the body phone.
 *     Then sends a 6-digit SMS code. Without the phone-match gate, an
 *     attacker who got hold of the gift email could complete the claim
 *     with their OWN phone — phone match is the email-forwarding defense.
 *
 *   POST /auth/customer/gift/claim
 *     Body: { claimToken, phone, code }. Verifies OTP, materializes the
 *     recipient customer (or reuses an existing match), mints the punch
 *     card with is_gift=true + buyer denormalized, marks the pending row
 *     claimed, sets the customer session cookie, fires the buyer
 *     claim-notification email outside the transaction.
 */

import { signCustomerToken } from '@memesh/auth';
import {
  createCustomer,
  createPunchCard,
  db,
  findPendingClaimByTokenHash,
  getWcProductCardConfig,
  markGiftClaimComplete,
  requestGiftClaimOtp,
  verifyGiftClaimOtp,
} from '@memesh/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { customerAuthConfig } from '../auth.js';
import { env } from '../config.js';
import { cookieScope } from '../lib/cookie-scope.js';
import { fireGiftBuyerClaimEmail } from '../lib/gift-email.js';
import { phoneSchema } from '../lib/phone-schema.js';
import { smsProvider } from '../lib/sms.js';
import { envKeyResolver } from '../qr.js';

const CUSTOMER_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const setCustomerCookie = (reply: FastifyReply, token: string): void => {
  reply.setCookie('customer_token', token, {
    ...cookieScope(),
    maxAge: CUSTOMER_SESSION_MAX_AGE_SEC,
  });
};

// Token-only param schema for /preview. We pass through the raw token string
// and hash it in the lookup helper; no need to constrain shape further.
const previewParamsSchema = z.object({
  claimToken: z.string().min(8).max(256),
});

const requestOtpSchema = z.object({
  claimToken: z.string().min(8).max(256),
  phone: phoneSchema,
});

const claimSchema = z.object({
  claimToken: z.string().min(8).max(256),
  phone: phoneSchema,
  code: z.string().regex(/^\d{4,8}$/),
});

export const giftClaimRoutes: FastifyPluginAsync = async (fastify) => {
  // -------------------------------------------------------------------------
  // GET /auth/customer/gift/preview/:claimToken
  // -------------------------------------------------------------------------
  fastify.get(
    '/auth/customer/gift/preview/:claimToken',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = previewParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_token' });
      }

      const row = await findPendingClaimByTokenHash(db, parsed.data.claimToken);
      if (!row) {
        request.log.info('[gift claim preview] token_unknown');
        return reply.code(404).send({ error: 'gift_not_found' });
      }
      if (row.claimedAt) {
        request.log.info(
          { pendingClaimId: row.id, claimedAt: row.claimedAt.toISOString() },
          '[gift claim preview] already_claimed',
        );
        return reply.code(410).send({ error: 'gift_already_claimed' });
      }
      const now = new Date();
      if (row.expiredAt || row.expiresAt.getTime() < now.getTime()) {
        request.log.info(
          { pendingClaimId: row.id },
          '[gift claim preview] expired',
        );
        return reply.code(410).send({ error: 'gift_expired' });
      }

      // Fetch the card teaser so the page can show "12 entries, valid X days".
      // Configs are cheap and the gift order is already committed; missing
      // config row is treated as "card details unavailable, claim still works".
      const config = await getWcProductCardConfig(db, row.wcSku);

      request.log.info(
        { pendingClaimId: row.id },
        '[gift claim preview] live',
      );
      return reply.send({
        ok: true,
        gift: {
          buyerFirstName: row.buyerFirstName,
          recipientFirstName: row.recipientFirstName,
          card: config
            ? {
                totalEntries: config.totalEntries,
                validityDays: config.validityDays,
              }
            : null,
          expiresAt: row.expiresAt.toISOString(),
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/customer/gift/request-otp
  // -------------------------------------------------------------------------
  fastify.post(
    '/auth/customer/gift/request-otp',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = requestOtpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      const row = await findPendingClaimByTokenHash(db, parsed.data.claimToken);
      if (!row) {
        request.log.info('[gift claim otp request] token_unknown');
        return reply.code(404).send({ error: 'gift_not_found' });
      }
      if (row.claimedAt) {
        return reply.code(410).send({ error: 'gift_already_claimed' });
      }
      const now = new Date();
      if (row.expiredAt || row.expiresAt.getTime() < now.getTime()) {
        return reply.code(410).send({ error: 'gift_expired' });
      }
      // Phone-match gate. Email-forwarding attacker has the token but cannot
      // present the recipient's actual phone (and would not get the OTP SMS
      // even if they tried — it goes to the legitimate recipient's number).
      if (row.recipientPhone !== parsed.data.phone) {
        request.log.warn(
          { pendingClaimId: row.id },
          '[gift claim otp request] phone_mismatch',
        );
        return reply.code(403).send({ error: 'phone_mismatch' });
      }

      const result = await requestGiftClaimOtp(db, parsed.data.phone, {
        pepper: env.SERVER_SECRET_KEY,
      });
      if (result.sent) {
        const res = await smsProvider.send({
          to: parsed.data.phone,
          body: `קוד הכניסה שלך לקבלת המתנה: ${result.code}`,
        });
        if (res.ok) {
          request.log.info(
            { pendingClaimId: row.id, providerId: res.id ?? null },
            '[gift claim otp request] sms sent',
          );
        } else {
          request.log.warn(
            { pendingClaimId: row.id, error: res.error },
            '[gift claim otp request] sms provider error AFTER row insert',
          );
        }
      } else {
        request.log.info(
          { pendingClaimId: row.id, reason: result.reason },
          '[gift claim otp request] not sent',
        );
      }
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/customer/gift/claim
  // -------------------------------------------------------------------------
  fastify.post(
    '/auth/customer/gift/claim',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = claimSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      const row = await findPendingClaimByTokenHash(db, parsed.data.claimToken);
      if (!row) {
        return reply.code(404).send({ error: 'gift_not_found' });
      }
      if (row.claimedAt) {
        return reply.code(410).send({ error: 'gift_already_claimed' });
      }
      const now = new Date();
      if (row.expiredAt || row.expiresAt.getTime() < now.getTime()) {
        return reply.code(410).send({ error: 'gift_expired' });
      }
      if (row.recipientPhone !== parsed.data.phone) {
        return reply.code(403).send({ error: 'phone_mismatch' });
      }

      // Verify OTP first (cheap, fail-fast). Same constant-time, attempt-
      // counted machinery the login OTP uses.
      const otpResult = await verifyGiftClaimOtp(
        db,
        parsed.data.phone,
        parsed.data.code,
        { pepper: env.SERVER_SECRET_KEY },
      );
      if (!otpResult.ok) {
        request.log.info(
          { pendingClaimId: row.id, reason: otpResult.reason },
          '[gift claim] otp_rejected',
        );
        if (otpResult.reason === 'locked') {
          return reply.code(401).send({ ok: false, error: 'code_locked' });
        }
        if (otpResult.reason === 'expired') {
          return reply.code(401).send({ ok: false, error: 'code_expired' });
        }
        return reply.code(401).send({ ok: false, error: 'invalid_code' });
      }

      const config = await getWcProductCardConfig(db, row.wcSku);
      if (!config) {
        // Pending row references an SKU whose config was deleted between
        // order time and claim time. We refuse the claim and surface a
        // failure for ops — auto-minting a "default" card here would be
        // worse than asking the admin to fix the SKU config.
        request.log.error(
          { pendingClaimId: row.id, wcSku: row.wcSku },
          '[gift claim] sku_config_missing',
        );
        return reply.code(500).send({ ok: false, error: 'sku_config_missing' });
      }

      // The actual mint runs in one transaction so a crash mid-flight cannot
      // leave a half-claimed row (claimed_at set, no card) or a card with no
      // pending-row pointer.
      const txResult = await db.transaction(async (tx) => {
        const { customers } = await import('@memesh/db');
        // Recipient may have become a Memesh customer between order time
        // and claim. Phone is the canonical identity — reuse if found,
        // create otherwise.
        const existing = await tx
          .select()
          .from(customers)
          .where(eq(customers.phone, row.recipientPhone))
          .limit(1);
        let recipientCustomerId: string;
        if (existing[0]) {
          recipientCustomerId = existing[0].id;
        } else {
          const created = await createCustomer(tx, {
            firstName: row.recipientFirstName,
            lastName: row.recipientLastName || row.recipientFirstName,
            phone: row.recipientPhone,
            email: row.recipientEmail,
            source: 'website',
            now,
          });
          recipientCustomerId = created.id;
        }

        const card = await createPunchCard(tx, envKeyResolver, {
          customerId: recipientCustomerId,
          totalEntries: config.totalEntries,
          validityDays: config.validityDays,
          source: 'online',
          wcOrderId: row.wcOrderId,
          gift: {
            buyerFirstName: row.buyerFirstName,
            buyerLastName: row.buyerLastName,
            buyerPhone: row.buyerPhone,
            claimedAt: now,
          },
          now,
        });

        const markResult = await markGiftClaimComplete(tx, {
          pendingId: row.id,
          mintedCardId: card.id,
          now,
        });
        if (!markResult.ok) {
          // Race condition: another concurrent claim attempt won. Roll back
          // the customer/card creation by throwing — the tx wrapper catches
          // and the caller surfaces an "already claimed" error to the user.
          throw new Error(`mark_complete_failed:${markResult.reason}`);
        }
        return { recipientCustomerId, cardId: card.id };
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('mark_complete_failed:')) {
          return { error: 'race_already_claimed' as const };
        }
        throw err;
      });

      if ('error' in txResult) {
        return reply.code(410).send({ ok: false, error: 'gift_already_claimed' });
      }

      // Buyer claim-notification email (fire-and-log). Honors the
      // giftBuyerNotifyOnClaim toggle internally so we don't have to
      // re-read settings here.
      void fireGiftBuyerClaimEmail(db, {
        buyerEmail: row.buyerEmail,
        buyerFirstName: row.buyerFirstName,
        recipientFirstName: row.recipientFirstName,
        orderId: row.wcOrderId,
        log: request.log,
      });

      // Sign in the recipient. Same shape the OTP login route uses so the
      // customer area treats this session indistinguishably from any other.
      const token = await signCustomerToken(
        txResult.recipientCustomerId,
        customerAuthConfig,
      );
      setCustomerCookie(reply, token);

      request.log.info(
        {
          pendingClaimId: row.id,
          customerId: txResult.recipientCustomerId,
          cardId: txResult.cardId,
        },
        '[gift claim] completed',
      );
      return reply.send({
        ok: true,
        token,
        customerId: txResult.recipientCustomerId,
      });
    },
  );
};
