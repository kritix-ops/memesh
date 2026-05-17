import type { AuthConfig } from '@memesh/auth';
import { env } from './config.js';

export const authConfig: AuthConfig = {
  secret: env.JWT_SECRET,
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
  accessTtl: '15m',
  refreshTtl: '7d',
};
