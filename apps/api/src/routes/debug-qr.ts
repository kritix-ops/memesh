import { isVerifyFailure, verifyToken } from '@memesh/qr-engine';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { requireRoleHook } from '../lib/auth-guards.js';
import { envKeyResolver } from '../qr.js';

// TEMPORARY DIAGNOSTIC. Plan: 2026-06-21-real-qr-codes.md / scan-fails-with-bad-signature
// investigation. The production /punch and /scan/lookup endpoints intentionally
// collapse every verifyToken failure into a single 401 invalid_signature so an
// attacker can't probe which part of the token they got wrong. That same
// collapse hides exactly the signal we need now — is the secret rotated
// (bad_signature), is the keyId unknown to this env (unknown_key_id), did
// qrcode.react truncate the payload (invalid_format / malformed_payload), or
// did some intermediary munge the version prefix (unknown_version)?
//
// This endpoint exposes the precise failure code but only to admin sessions.
// It also reports back what keyId the token claims vs what keyId the env
// currently signs with, so a mismatch is obvious without DB access.
//
// REMOVE THIS FILE (and its registration in app.ts) once the investigation
// resolves. Not intended to ship long-term.

const bodySchema = z.object({
  token: z.string().min(1).max(2048),
});

// Cheap structural unwrap so we can show "what keyId does the token claim?"
// even when verification fails. Does *not* trust the result for any
// authorization — purely a debug aid.
const peekTokenStructure = (
  token: string,
): {
  version: string | null;
  payloadKeyId: string | null;
  payloadSerial: string | null;
  payloadCreatedTs: number | null;
  payloadCustomerIdSuffix: string | null;
} => {
  const parts = token.split('.');
  const version = parts[0] ?? null;
  const payloadB64 = parts[1];
  if (!payloadB64) {
    return {
      version,
      payloadKeyId: null,
      payloadSerial: null,
      payloadCreatedTs: null,
      payloadCustomerIdSuffix: null,
    };
  }
  try {
    const decoded = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const fields = decoded.split('|');
    // Order matches qr-engine: punchCardId | customerId | createdTs | serial | keyId.
    const [, customerId, createdTsStr, serial, keyId] = fields;
    return {
      version,
      payloadKeyId: keyId ?? null,
      payloadSerial: serial ?? null,
      payloadCreatedTs: createdTsStr ? Number(createdTsStr) : null,
      // Only the suffix — full customer id is PII even for an admin debug surface.
      payloadCustomerIdSuffix: customerId ? customerId.slice(-12) : null,
    };
  } catch {
    return {
      version,
      payloadKeyId: null,
      payloadSerial: null,
      payloadCreatedTs: null,
      payloadCustomerIdSuffix: null,
    };
  }
};

export const debugQrRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/debug/qr/verify',
    {
      preHandler: requireRoleHook('admin'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const { token } = parsed.data;

      const structure = peekTokenStructure(token);
      const verified = verifyToken(token, envKeyResolver);
      const verifyResult = isVerifyFailure(verified) ? verified.error : 'ok';

      request.log.info(
        {
          verifyResult,
          tokenLen: token.length,
          payloadKeyId: structure.payloadKeyId,
          envKeyId: env.QR_KEY_ID,
        },
        '[debug qr] verify-token probe',
      );

      return {
        verifyResult,
        envKeyId: env.QR_KEY_ID,
        tokenStructure: structure,
        // True iff the token's stated keyId matches what this env signs with.
        // When this is false but verifyResult is unknown_key_id, the verdict
        // is "card was minted in a different env." When this is true but
        // verifyResult is bad_signature, the verdict is "secret was rotated
        // without re-minting cards."
        keyIdMatchesEnv: structure.payloadKeyId === env.QR_KEY_ID,
      };
    },
  );
};
