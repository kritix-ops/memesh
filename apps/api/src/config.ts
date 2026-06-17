import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVER_SECRET_KEY: z.string().min(32, 'SERVER_SECRET_KEY must be at least 32 characters'),
  QR_KEY_ID: z.string().min(1).default('1'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('memesh'),
  JWT_AUDIENCE: z.string().default('memesh-api'),
  JWT_CUSTOMER_AUDIENCE: z.string().default('memesh-customer'),
  // WordPress one-way sync (optional). When unset, sync is disabled and customer
  // creation simply skips it.
  WP_BASE_URL: z.string().url().optional(),
  WP_SYNC_USER: z.string().optional(),
  WP_SYNC_APP_PASSWORD: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
