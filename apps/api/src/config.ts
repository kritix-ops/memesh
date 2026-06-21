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
  // Cross-origin frontends allowlist for the split-subdomain topology. Comma-
  // separated absolute origins, e.g.
  //   "https://staff.memesh.co.il,https://admin.memesh.co.il,https://my.memesh.co.il"
  // Unset means: same-origin deploy (apps/web today), CORS falls back to
  // `origin: false` in production and `origin: true` in development.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Cookie scope for the split-subdomain topology. When set (e.g. ".memesh.co.il"),
  // the auth + customer cookies include a Domain attribute so they survive the
  // cross-subdomain hop from frontend to api.memesh.co.il. Unset means cookies
  // stay origin-scoped (current single-origin behaviour, safe for dev).
  COOKIE_DOMAIN: z.string().optional(),
  // Shared secret used by the WordPress checkout-handoff plugin to call the
  // /auth/customer/wc-handoff/mint endpoint. 32+ chars. Set on both the
  // memesh-api Vercel project (as WP_HANDOFF_SHARED_SECRET) and on the WP
  // host environment (as MEMESH_HANDOFF_SECRET) — values must match.
  // Unset = the mint route refuses every request with 503, so the feature
  // stays off in dev without an explicit opt-in.
  WP_HANDOFF_SHARED_SECRET: z.string().min(32).optional(),
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
  // Reconciliation cron auth. Vercel Cron auto-injects this as
  // `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET is set in the
  // project env. The cron route compares constant-time and 401s on mismatch.
  CRON_SECRET: z.string().min(32).optional(),
  // WooCommerce REST API credentials, used only by the reconciliation cron
  // to fetch completed orders from the last N hours and heal missing cards.
  // Generated in WC admin → Settings → Advanced → REST API → Add key.
  // Read permission only; the cron never writes to WC.
  WC_API_URL: z.string().url().optional(),
  WC_API_CONSUMER_KEY: z.string().optional(),
  WC_API_CONSUMER_SECRET: z.string().optional(),
  // How far back the reconciliation cron looks. Wide enough to catch
  // overnight outages, narrow enough that the WC orders endpoint stays
  // cheap. Override per-deploy if needed.
  WC_RECONCILE_LOOKBACK_HOURS: z.coerce.number().int().positive().max(168).default(48),
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
  // Email provider selection for the customer email-OTP fallback. 'console'
  // (default) logs each message to stdout — fine for dev and the first
  // production boot before the Resend account/domain are verified. 'resend'
  // is the live provider; requires RESEND_API_KEY + EMAIL_FROM (a verified
  // sender on the Memesh domain). See _plans/2026-06-20-seller-attribution-
  // and-email-fallback.md for the integration plan.
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
