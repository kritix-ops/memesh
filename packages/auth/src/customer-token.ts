import { jwtVerify, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { AuthVerifyResult } from './errors';
import { type AuthConfig, mapJoseError } from './jwt';

// Customer sessions carry no staff role and use a separate audience from staff
// tokens, so a customer token can never be replayed against staff/admin routes
// (and vice versa). Pass an AuthConfig with the customer audience.
export interface CustomerClaims {
  sub: string; // customer id
  iat: number;
  exp: number;
  jti?: string;
  iss?: string;
  aud?: string | string[];
}

const toKey = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export const signCustomerToken = async (customerId: string, config: AuthConfig): Promise<string> =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(customerId)
    .setIssuedAt()
    .setExpirationTime(config.accessTtl ?? '7d')
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setJti(randomUUID())
    .sign(toKey(config.secret));

export const verifyCustomerToken = async (
  token: string,
  config: AuthConfig,
): Promise<AuthVerifyResult<CustomerClaims>> => {
  try {
    const { payload } = await jwtVerify(token, toKey(config.secret), {
      issuer: config.issuer,
      audience: config.audience,
    });
    if (payload.typ === 'refresh') {
      return { ok: false, error: 'wrong_token_type' };
    }
    return { ok: true, claims: payload as unknown as CustomerClaims };
  } catch (err) {
    return { ok: false, error: mapJoseError(err) };
  }
};
