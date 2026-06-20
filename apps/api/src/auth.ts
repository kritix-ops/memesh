import type { AuthConfig } from '@memesh/auth';
import { env } from './config.js';

export const authConfig: AuthConfig = {
  secret: env.JWT_SECRET,
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
  accessTtl: '15m',
  refreshTtl: '7d',
};

// Customer sessions use a separate audience so they are not interchangeable with
// staff tokens. OTP login is low-friction, so the session lasts longer.
export const customerAuthConfig: AuthConfig = {
  secret: env.JWT_SECRET,
  issuer: env.JWT_ISSUER,
  audience: env.JWT_CUSTOMER_AUDIENCE,
  accessTtl: '7d',
};
