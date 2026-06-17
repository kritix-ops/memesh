import { jwtVerify, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { AuthVerifyError, AuthVerifyResult } from './errors';
import type { AccessClaims, RefreshClaims, StaffRole } from './types';

export interface AuthConfig {
  secret: string;
  issuer: string;
  audience: string;
  accessTtl?: string;
  refreshTtl?: string;
}

export interface TokenPayload {
  sub: string;
  role: StaffRole;
}

const toKey = (secret: string): Uint8Array => new TextEncoder().encode(secret);

const mapJoseError = (err: unknown): AuthVerifyError => {
  if (!(err instanceof Error)) return 'invalid_format';
  switch (err.name) {
    case 'JWTExpired':
      return 'expired';
    case 'JWSSignatureVerificationFailed':
      return 'invalid_signature';
    case 'JWTClaimValidationFailed':
      return 'invalid_claims';
    case 'JWTInvalid':
    case 'JWSInvalid':
      return 'invalid_format';
    default:
      return 'invalid_format';
  }
};

export const signAccessToken = async (payload: TokenPayload, config: AuthConfig): Promise<string> =>
  new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(config.accessTtl ?? '15m')
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setJti(randomUUID())
    .sign(toKey(config.secret));

export const signRefreshToken = async (
  payload: TokenPayload,
  config: AuthConfig,
): Promise<string> =>
  new SignJWT({ role: payload.role, typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(config.refreshTtl ?? '7d')
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setJti(randomUUID())
    .sign(toKey(config.secret));

export const verifyAccessToken = async (
  token: string,
  config: AuthConfig,
): Promise<AuthVerifyResult<AccessClaims>> => {
  try {
    const { payload } = await jwtVerify(token, toKey(config.secret), {
      issuer: config.issuer,
      audience: config.audience,
    });
    if (payload.typ === 'refresh') {
      return { ok: false, error: 'wrong_token_type' };
    }
    if (typeof payload.role !== 'string') {
      return { ok: false, error: 'invalid_claims' };
    }
    return { ok: true, claims: payload as unknown as AccessClaims };
  } catch (err) {
    return { ok: false, error: mapJoseError(err) };
  }
};

export const verifyRefreshToken = async (
  token: string,
  config: AuthConfig,
): Promise<AuthVerifyResult<RefreshClaims>> => {
  try {
    const { payload } = await jwtVerify(token, toKey(config.secret), {
      issuer: config.issuer,
      audience: config.audience,
    });
    if (payload.typ !== 'refresh') {
      return { ok: false, error: 'wrong_token_type' };
    }
    if (typeof payload.role !== 'string') {
      return { ok: false, error: 'invalid_claims' };
    }
    return { ok: true, claims: payload as unknown as RefreshClaims };
  } catch (err) {
    return { ok: false, error: mapJoseError(err) };
  }
};
