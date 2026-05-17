import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVER_SECRET_KEY: z
    .string()
    .min(32, 'SERVER_SECRET_KEY must be at least 32 characters'),
  QR_KEY_ID: z.string().min(1).default('1'),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('memesh'),
  JWT_AUDIENCE: z.string().default('memesh-api'),
  WC_WEBHOOK_SECRET: z
    .string()
    .min(20, 'WC_WEBHOOK_SECRET must be at least 20 characters'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
