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
  // WooCommerce → Memesh integration. Required in production for the webhook
  // route to start; left optional so dev/test boots without the secret. WC
  // signs each delivery with HMAC-SHA256 over the raw body using this string
  // (configured in WooCommerce → Settings → Advanced → Webhooks).
  WC_WEBHOOK_SECRET: z.string().min(32).optional(),
  // Reconciliation cron auth (PR 3 wires the cron itself). Bearer token must
  // match Authorization header on /cron/* requests.
  CRON_SECRET: z.string().min(32).optional(),
  // SMS provider selection. 'console' is the safe default and logs each
  // message to stdout. 'pulseem' is the production provider (the account
  // Yanai signed up for at pulseem.co.il); requires PULSEEM_API_KEY +
  // PULSEEM_FROM_NUMBER. '019' is a DRAFT alternative that was never wired
  // to a live account — kept in the tree but no longer recommended.
  SMS_PROVIDER: z.enum(['console', 'pulseem', '019']).default('console'),
  PULSEEM_API_KEY: z.string().optional(),
  PULSEEM_FROM_NUMBER: z.string().optional(),
  PULSEEM_BASE_URL: z.string().url().optional(),
  SMS_019_TOKEN: z.string().optional(),
  SMS_019_SOURCE: z.string().max(11).optional(),
  SMS_019_ENDPOINT: z.string().url().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
