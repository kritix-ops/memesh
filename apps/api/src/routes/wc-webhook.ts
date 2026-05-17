import { db, tickets } from '@memesh/db';
import { signToken } from '@memesh/qr-engine';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../config.js';
import {
  COMPANION_WC_PRODUCT_ID,
  PUNCH_CARD_ENTRIES,
  PUNCH_CARD_VALIDITY_DAYS,
  WC_PRODUCT_TO_TICKET_TYPE,
  isKnownWcProductId,
  isPrimaryWcProductId,
} from '../constants.js';
import { allocateSerial } from '../lib/serial-allocator.js';
import { findOrCreateUserByWp } from '../lib/users-repo.js';
import { verifyWcSignature, type WcOrderPayload } from '../lib/wc-webhook.js';
import { envKeyResolver } from '../qr.js';

interface CreatedTicketSummary {
  id: string;
  ticketType: string;
  serial: string;
  companionTicketId: string | null;
}

const computeExpiresAt = (ticketType: string): Date | null => {
  if (ticketType === 'punch_card') {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + PUNCH_CARD_VALIDITY_DAYS);
    return d;
  }
  return null;
};

const computeTotalEntries = (ticketType: string): number | null => {
  if (ticketType === 'punch_card') return PUNCH_CARD_ENTRIES;
  return null;
};

export const wcWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/webhooks/woocommerce/order-completed',
    async (request: FastifyRequest, reply) => {
      const rawBody = request.rawBody;
      if (!rawBody) {
        request.log.warn('[wc webhook] missing raw body — content-type parser misconfigured');
        return reply.code(400).send({ error: 'no_body' });
      }

      const signature = request.headers['x-wc-webhook-signature'];
      const sigStr = Array.isArray(signature) ? signature[0] : signature;
      if (!verifyWcSignature(rawBody, sigStr, env.WC_WEBHOOK_SECRET)) {
        request.log.warn(
          { hasSig: Boolean(sigStr) },
          '[wc webhook] signature verification failed',
        );
        return reply.code(401).send({ error: 'invalid_signature' });
      }

      let payload: WcOrderPayload;
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as WcOrderPayload;
      } catch (err) {
        request.log.warn({ err }, '[wc webhook] body is not JSON');
        return reply.code(400).send({ error: 'invalid_json' });
      }

      const wcOrderIdStr = String(payload.id);

      const alreadyProcessed = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.wcOrderId, wcOrderIdStr))
        .limit(1);
      if (alreadyProcessed[0]) {
        request.log.info(
          { wcOrderId: wcOrderIdStr },
          '[wc webhook] order already processed, returning 200',
        );
        return reply.code(200).send({ status: 'already_processed' });
      }

      if (!payload.line_items || payload.line_items.length === 0) {
        request.log.info(
          { wcOrderId: wcOrderIdStr },
          '[wc webhook] no line items, nothing to do',
        );
        return reply.code(200).send({ status: 'no_line_items' });
      }

      const { id: ownerId } = await findOrCreateUserByWp(payload.customer_id, payload.billing);
      request.log.info(
        { wcOrderId: wcOrderIdStr, ownerId, customerId: payload.customer_id },
        '[wc webhook] owner resolved',
      );

      const primaries: { productId: number; ticketType: string }[] = [];
      let companionCount = 0;
      for (const item of payload.line_items) {
        for (let q = 0; q < (item.quantity ?? 1); q += 1) {
          if (!isKnownWcProductId(item.product_id)) continue;
          if (isPrimaryWcProductId(item.product_id)) {
            primaries.push({
              productId: item.product_id,
              ticketType: WC_PRODUCT_TO_TICKET_TYPE[item.product_id],
            });
          } else if (item.product_id === COMPANION_WC_PRODUCT_ID) {
            companionCount += 1;
          }
        }
      }

      if (primaries.length === 0 && companionCount > 0) {
        request.log.warn(
          { wcOrderId: wcOrderIdStr },
          '[wc webhook] companion without primary in order, skipping companion',
        );
      }
      if (companionCount > 1) {
        request.log.warn(
          { wcOrderId: wcOrderIdStr, companionCount },
          '[wc webhook] multiple companions in single order, treating as one',
        );
      }

      const created: CreatedTicketSummary[] = [];

      // Pass 1: create primary tickets
      const primaryRows: { id: string; ticketType: string }[] = [];
      for (const p of primaries) {
        const serial = await allocateSerial();
        const expiresAt = computeExpiresAt(p.ticketType);
        const totalEntries = computeTotalEntries(p.ticketType);
        const inserted = await db
          .insert(tickets)
          .values({
            ownerId,
            ticketType: p.ticketType as 'child_single' | 'baby_single' | 'punch_card',
            qrToken: 'pending',
            serialNumber: serial,
            totalEntries,
            wcOrderId: wcOrderIdStr,
            wcProductId: p.productId,
            source: 'online',
            ...(expiresAt ? { expiresAt } : {}),
          })
          .returning({ id: tickets.id });
        const row = inserted[0];
        if (!row) throw new Error('[wc webhook] primary ticket insert returned no row');

        const createdTs = Math.floor(Date.now() / 1000);
        const qrToken = signToken(
          { ticketId: row.id, userId: ownerId, createdTs, serial },
          envKeyResolver,
        );
        await db.update(tickets).set({ qrToken }).where(eq(tickets.id, row.id));

        primaryRows.push({ id: row.id, ticketType: p.ticketType });
        created.push({ id: row.id, ticketType: p.ticketType, serial, companionTicketId: null });
        request.log.info(
          { ticketId: row.id, ticketType: p.ticketType, serial, wcOrderId: wcOrderIdStr },
          '[wc webhook] primary ticket created',
        );
      }

      // Pass 2: create one companion ticket if applicable, linked to first primary
      if (primaryRows[0] && companionCount > 0) {
        const linkedPrimary = primaryRows[0];
        const serial = await allocateSerial();
        const inserted = await db
          .insert(tickets)
          .values({
            ownerId,
            ticketType: 'companion',
            qrToken: 'pending',
            serialNumber: serial,
            wcOrderId: wcOrderIdStr,
            wcProductId: COMPANION_WC_PRODUCT_ID,
            companionTicketId: linkedPrimary.id,
            source: 'online',
          })
          .returning({ id: tickets.id });
        const row = inserted[0];
        if (!row) throw new Error('[wc webhook] companion ticket insert returned no row');

        const createdTs = Math.floor(Date.now() / 1000);
        const qrToken = signToken(
          { ticketId: row.id, userId: ownerId, createdTs, serial },
          envKeyResolver,
        );
        await db.update(tickets).set({ qrToken }).where(eq(tickets.id, row.id));

        created.push({
          id: row.id,
          ticketType: 'companion',
          serial,
          companionTicketId: linkedPrimary.id,
        });
        request.log.info(
          { ticketId: row.id, companionOf: linkedPrimary.id, serial, wcOrderId: wcOrderIdStr },
          '[wc webhook] companion ticket created',
        );
      }

      request.log.info(
        {
          wcOrderId: wcOrderIdStr,
          phone: payload.billing.phone,
          ticketCount: created.length,
        },
        '[wc webhook sms] would send SMS — wire SMS provider in follow-up',
      );

      return reply.code(200).send({ status: 'created', tickets: created });
    },
  );
};
