import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerifyResult } from './errors.js';

export interface TokenPayload {
  ticketId: string;
  userId: string;
  createdTs: number;
  serial: string;
  keyId: string;
}

export interface SigningKey {
  keyId: string;
  secret: string;
}

export interface KeyResolver {
  resolveSigningKey(): SigningKey;
  resolveVerifyKey(keyId: string): string | undefined;
}

const TOKEN_VERSION = 'v1';
const PAYLOAD_DELIMITER = '|';

const serialise = (payload: TokenPayload): string =>
  [
    payload.ticketId,
    payload.userId,
    payload.createdTs.toString(),
    payload.serial,
    payload.keyId,
  ].join(PAYLOAD_DELIMITER);

const deserialise = (raw: string): TokenPayload | undefined => {
  const parts = raw.split(PAYLOAD_DELIMITER);
  if (parts.length !== 5) return undefined;
  const [ticketId, userId, createdTsStr, serial, keyId] = parts;
  if (!ticketId || !userId || !createdTsStr || !serial || !keyId) return undefined;
  const createdTs = Number(createdTsStr);
  if (!Number.isFinite(createdTs)) return undefined;
  return { ticketId, userId, createdTs, serial, keyId };
};

const hmac = (payload: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(payload, 'utf8').digest();

const safeEqual = (a: Buffer, b: Buffer): boolean => {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const signToken = (
  payload: Omit<TokenPayload, 'keyId'>,
  resolver: KeyResolver,
): string => {
  const { keyId, secret } = resolver.resolveSigningKey();
  const fullPayload: TokenPayload = { ...payload, keyId };
  const serialised = serialise(fullPayload);
  const sig = hmac(serialised, secret);
  const payloadB64 = Buffer.from(serialised, 'utf8').toString('base64url');
  const sigB64 = sig.toString('base64url');
  return `${TOKEN_VERSION}.${payloadB64}.${sigB64}`;
};

export const verifyToken = (
  token: string,
  resolver: KeyResolver,
): VerifyResult<TokenPayload> => {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'invalid_format' };
  const [version, payloadB64, sigB64] = parts;
  if (!version || !payloadB64 || !sigB64) return { ok: false, error: 'invalid_format' };
  if (version !== TOKEN_VERSION) return { ok: false, error: 'unknown_version' };
  let payloadStr: string;
  let sig: Buffer;
  try {
    payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    sig = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, error: 'invalid_format' };
  }
  const payload = deserialise(payloadStr);
  if (!payload) return { ok: false, error: 'malformed_payload' };
  const secret = resolver.resolveVerifyKey(payload.keyId);
  if (!secret) return { ok: false, error: 'unknown_key_id' };
  const expected = hmac(payloadStr, secret);
  if (!safeEqual(sig, expected)) return { ok: false, error: 'bad_signature' };
  return { ok: true, payload };
};
