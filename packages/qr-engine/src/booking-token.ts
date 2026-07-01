import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerifyResult } from './errors.js';
import type { KeyResolver } from './token.js';

// Round-booking barcode token. Same HMAC-SHA256 + key-rotation scheme as the
// punch-card token, but signs the booking id + a monotonic version. A swap
// bumps barcode_version and re-mints, so an old QR (screenshotted before the
// swap) fails verification because its signed version no longer matches the
// booking's current version, which the scanner checks server-side.
export interface BookingTokenPayload {
  bookingId: string;
  version: number;
  keyId: string;
}

// Distinct prefix from the card token ('v1') so the two token families can
// never be confused at a scanner.
const TOKEN_VERSION = 'b1';
const DELIM = '|';

const serialise = (p: BookingTokenPayload): string =>
  [p.bookingId, p.version.toString(), p.keyId].join(DELIM);

const deserialise = (raw: string): BookingTokenPayload | undefined => {
  const parts = raw.split(DELIM);
  if (parts.length !== 3) return undefined;
  const [bookingId, versionStr, keyId] = parts;
  if (!bookingId || !versionStr || !keyId) return undefined;
  const version = Number(versionStr);
  if (!Number.isInteger(version)) return undefined;
  return { bookingId, version, keyId };
};

const hmac = (payload: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(payload, 'utf8').digest();

const safeEqual = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && timingSafeEqual(a, b);

export const signBookingToken = (
  payload: Omit<BookingTokenPayload, 'keyId'>,
  resolver: KeyResolver,
): string => {
  const { keyId, secret } = resolver.resolveSigningKey();
  const serialised = serialise({ ...payload, keyId });
  const sig = hmac(serialised, secret);
  const payloadB64 = Buffer.from(serialised, 'utf8').toString('base64url');
  return `${TOKEN_VERSION}.${payloadB64}.${sig.toString('base64url')}`;
};

export const verifyBookingToken = (
  token: string,
  resolver: KeyResolver,
): VerifyResult<BookingTokenPayload> => {
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
