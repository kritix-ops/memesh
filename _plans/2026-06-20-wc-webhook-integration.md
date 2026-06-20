# WooCommerce → API webhook integration (online כרטיסייה purchases)

**Status:** proposed 2026-06-20, awaiting Yoav approval.

## Goal

When a customer buys a כרטיסייה on `memesh.co.il` (WooCommerce), a punch card
must materialize **in the new Memesh system** automatically — linked to a
customer (by normalized phone), with the correct number of entries and
validity, ready to scan at the POS.

**Hard architectural rule: WooCommerce is for payment only.** The card is
created in our system, owned by our system, scanned through our system,
expired/cancelled by our system. WC never holds card state. The existing
"Event Tickets" plugin on WP (which today generates `MEMESH...` redemption
codes) is being replaced by this flow — it stops being the source of truth
the moment this webhook ships.

WP/WooCommerce stays the storefront, payment processor, and tax-receipt
issuer (Cloudways). The new Memesh system on Vercel is the operational
source of truth for cards, punches, and bookings. Communication is one-way
for v1: **WC → API**, never the other way.

## Locked decisions

| Question | Answer |
|---|---|
| Where does the new system run? | Vercel (the existing `memesh` project — same deploy as the web app, behind `/api/*`). |
| Where does WP/WC run? | Cloudways. No move. |
| Mechanism for WC → API? | Native WooCommerce webhook (admin UI configured). No custom WP plugin in v1. |
| Customer-identity join key? | Normalized phone. WC checkout phone is mandatory (confirmed by Yoav). |
| Products in scope for v1 | WC SKU **1004** only ("משלמים על 10 כניסות ומקבלים 12", ₪550). |
| Default for SKU 1004 → `totalEntries` | **12** |
| Default for SKU 1004 → `validityDays` | **`null` (no expiry / forever).** Confirmed by Yanay 2026-06-20. Admin can override per card via the existing admin card-control flow (see `_plans/2026-06-20-admin-card-control.md`). |
| Mapping shape | DB table `wc_product_card_configs`, seeded with one row. Future SKUs added without code. |
| Idempotency primitive | `wc_processed_webhooks(delivery_id)` unique constraint + atomic transaction. |
| Safety net for missed webhooks | Hourly reconciliation cron pulling WC REST API. |
| Failure when phone missing/invalid in WC payload | Reject 200 + flag in `wc_webhook_failures` for manual review (do NOT silently drop). |
| WP user creation for WC-purchased customers | **Skip** `syncCustomerToWp` for them — WC checkout already creates a WP user. If `billing.customer_id !== 0`, store that value as `wpUserId` on our customer row. If `0` (guest), leave `wpUserId` null. |
| Guest checkout support | **Yes.** Phone is mandatory in WC checkout, so the customer-join key always exists. |
| Marketing consent | Capture from WC checkbox if present; default to `null` (no consent) otherwise. Transactional purchase SMS still goes out — only marketing dispatch is gated on consent. |

## Brutally honest notes

- **There is no perfect idempotency without ordering control.** Webhook +
  reconciliation can race. We mitigate with a transactional Postgres
  advisory lock keyed on the WC order id (`pg_advisory_xact_lock`).
  Whichever code path acquires the lock first does the work; the other
  reads the resulting card rows and no-ops.
- **WC sometimes fires the "updated" topic for events we don't care about**
  (status flips back, admin edits, refunds). The handler filters by
  `status === 'completed'` and only acts on that transition. Everything
  else is logged and 200'd.
- **Manual order edits in WC after card creation are not propagated.** If
  the admin in WP edits an order from "completed" to "refunded" three days
  later, we don't auto-cancel the card. That is intentional for v1 — too
  many ways to do it wrong silently. Refunds are an admin action in the
  new system (existing cancel flow). Flagged as a v2 question.
- **The "validity" for SKU 1004 is the open question that blocks ship.**
  See "Open questions" — Yoav, I need an answer before code.

## Hosting + cost (verified live 2026-06-20)

**Vercel** — already in use, `memesh` project.

| Plan | Monthly | Notes |
|---|---|---|
| Hobby | Free | TOS forbids commercial — **NOT usable** for Memesh. |
| Pro | **$20 / user / month** | Includes $20 usage credit, 1 TB bandwidth, 1M function invocations, cron jobs. |
| Pro overage | $0.128 / Active-CPU-hour, $0.60 / 1M invocations, $0.15 / GB transfer after 1 TB | Marginal cost at Memesh's volume: ~$0 for the foreseeable future. |

**Neon Postgres** — already provisioned via Vercel-Neon Marketplace integration.

| Plan | Monthly | Notes |
|---|---|---|
| Free | $0 | 0.5 GB storage, 100 CU-hours / month, 6h history retention. Fine for v1 / early production. |
| Launch | Pay-as-you-go | $0.106 / CU-hour, $0.35 / GB-month, 7 days retention. Upgrade when storage > 0.5 GB or retention matters. |
| Scale | Pay-as-you-go | $0.222 / CU-hour, 30 days retention. Not needed yet. |

**Bottom line for this feature:** zero marginal cost beyond the Vercel Pro
seat already being paid. Cron job is included. Function invocations from
the webhook are a rounding error against the 1M/month allowance.

(WordPress on Cloudways: no change. Existing plan continues.)

## Architecture

```
   Customer buys כרטיסייה on memesh.co.il
              │
              │ WooCommerce processes payment (Cloudways)
              ▼
   WC "order updated" → status: completed
              │
              │ WC native webhook: POST + HMAC-signed body
              ▼
   https://memesh-opal.vercel.app/api/webhooks/woocommerce/order
              │
              │ Fastify route (apps/api/src/routes/webhooks-wc.ts)
              │ ├─ Verify X-WC-Webhook-Signature against raw body (HMAC-SHA256)
              │ ├─ Check wc_processed_webhooks for delivery_id → skip if seen
              │ ├─ Acquire pg_advisory_xact_lock(hashtext('wc_order:' || orderId))
              │ ├─ For each line item with SKU in wc_product_card_configs:
              │ │   For i in 1..quantity:
              │ │     - Resolve or create customer by normalized billing.phone
              │ │     - createPunchCard(customerId, totalEntries, validityDays,
              │ │                       source='online', wcOrderId)
              │ ├─ Insert wc_processed_webhooks(delivery_id)
              │ └─ Return 200
              ▼
   Neon Postgres

   Hourly cron (Vercel Cron, /api/cron/wc-reconcile)
              │
              │ Pulls WC REST API: orders status=completed, after=now-48h
              │ For each order: count expected cards vs actual
              │ Fill the gap using the same logic (same lock, no delivery_id)
              ▼
   Neon Postgres
```

## Backend

### db schema changes

New tables (one migration):

```ts
// packages/db/src/schema/wc-product-card-configs.ts
export const wcProductCardConfigs = pgTable('wc_product_card_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  wcSku: varchar('wc_sku', { length: 64 }).notNull().unique(),
  totalEntries: integer('total_entries').notNull(),
  // null = forever (matches card_settings sentinel). 0 = forever too. 1..3650 days.
  validityDays: integer('validity_days'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// packages/db/src/schema/wc-processed-webhooks.ts
export const wcProcessedWebhooks = pgTable('wc_processed_webhooks', {
  deliveryId: varchar('delivery_id', { length: 128 }).primaryKey(),
  wcOrderId: varchar('wc_order_id', { length: 64 }).notNull(),
  topic: varchar('topic', { length: 64 }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

// packages/db/src/schema/wc-webhook-failures.ts
// Manual-review queue for webhooks we received but couldn't process safely
// (missing phone, unknown SKU, validation failure). NEVER drop silently.
export const wcWebhookFailures = pgTable('wc_webhook_failures', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: varchar('delivery_id', { length: 128 }),
  wcOrderId: varchar('wc_order_id', { length: 64 }),
  reason: varchar('reason', { length: 64 }).notNull(),
  payload: jsonb('payload').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => staff.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Seed (a separate seed function, not a data migration):

```ts
// On first prod boot or via pnpm --filter=@memesh/api seed:wc-configs
{
  wcSku: '1004',
  totalEntries: 12,
  validityDays: null, // forever, per Yanay 2026-06-20.
                      // Admin can still override per card via the existing
                      // admin card-control flow.
  isActive: true,
}
```

### db functions

```ts
// packages/db/src/wc-orders.ts (new file)

/** Look up the card config for a WC SKU. Returns null if unknown or inactive. */
export const getWcProductCardConfig = async (db, wcSku: string)

/** Insert delivery_id; returns true if inserted (new), false if conflict (seen). */
export const markWcWebhookProcessed = async (db, input: { deliveryId, wcOrderId, topic })

/** Count cards already created for a WC order, optionally filtered by line-item id. */
export const countCardsForWcOrder = async (db, wcOrderId: string): Promise<number>

/** Record a failure for manual review. Idempotent on deliveryId+reason. */
export const recordWcWebhookFailure = async (db, input)

/**
 * Resolve a customer by normalized phone, or create one if absent.
 * Reuses the existing createCustomer + phone normalization. Returns the
 * customer row plus a `created` boolean for logging.
 */
export const resolveOrCreateCustomerFromWc = async (db, input: {
  phone: string;
  firstName: string;
  lastName: string;
  email: string | null;
  marketingConsent: boolean;
}): Promise<{ customer: Customer; created: boolean }>
```

### API

New plugin: `apps/api/src/routes/webhooks-wc.ts`. Mounted at
`/webhooks/woocommerce/*`. Registered in `apps/api/src/app.ts` like the
other route modules.

**Route shape:**

```
POST /webhooks/woocommerce/order
GET  /webhooks/woocommerce/health   ← unauthenticated, returns { ok: true }
POST /cron/wc-reconcile             ← Vercel Cron only (header gate)
```

**Raw-body handling (critical):** Fastify parses JSON by default; HMAC
verification needs the byte-exact raw body. Use a child plugin with a
scoped `addContentTypeParser` that captures the buffer:

```ts
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, JSON.parse(body.toString('utf8'))); }
    catch (err) { done(err as Error); }
  },
);
```

Scope it to this plugin only so we don't change parsing for the rest of
the API.

**Handler steps:**

1. Read `X-WC-Webhook-Signature`, `X-WC-Webhook-Topic`, `X-WC-Webhook-Delivery-ID`, `X-WC-Webhook-Source` headers.
2. Verify `User-Agent` starts with `WooCommerce` (cheap bot filter; not security).
3. Compute `crypto.createHmac('sha256', env.WC_WEBHOOK_SECRET).update(rawBody).digest('base64')` and `timingSafeEqual` vs the header.
4. If mismatch → 401, log `[webhook wc] signature_invalid` with delivery_id.
5. Parse `topic`. Only `order.updated` and `order.created` proceed. Anything else: log and 200.
6. Parse body. If `body.status !== 'completed'` → log `[webhook wc] ignored_non_completed` and 200.
7. Open a DB transaction:
   - `pg_advisory_xact_lock(hashtext('wc_order:' || body.id::text))` — serializes webhook + reconciliation for this order.
   - `markWcWebhookProcessed(deliveryId, ...)`: if conflict, return 200 (already processed).
   - Resolve customer: normalize `billing.phone`. If empty/invalid → `recordWcWebhookFailure` with reason `phone_missing`, COMMIT, return 200.
   - For each line item:
     - Look up `getWcProductCardConfig(sku)`. Skip line items with no match.
     - For `i` in `1..quantity`:
       - `existing = countCardsForWcOrder(wcOrderId)` (within tx)
       - If we've already created enough cards for this order (idempotent reconciliation case) → break.
       - Else `createPunchCard({ customerId, totalEntries, validityDays, source: 'online', wcOrderId })`.
8. COMMIT. Return 200 with `{ processed: <n>, cards: [serial...] }`.
9. On any thrown error: log `[webhook wc] exception` with stack, ROLLBACK (Postgres does this on tx abort), return 500. WC will retry.

**Env vars (additions to `apps/api/src/config.ts`):**

```ts
WC_WEBHOOK_SECRET: z.string().min(32).optional(),  // shared with WC webhook config
WC_API_URL: z.string().url().optional(),           // e.g. https://memesh.co.il/wp-json/wc/v3
WC_API_CONSUMER_KEY: z.string().optional(),        // for reconciliation cron only
WC_API_CONSUMER_SECRET: z.string().optional(),     // for reconciliation cron only
CRON_SECRET: z.string().min(32).optional(),        // gate for /cron/* routes
```

Webhook route refuses to start if `WC_WEBHOOK_SECRET` is unset in
production. Reconciliation refuses to run if WC API creds are unset.

### Reconciliation cron

`POST /cron/wc-reconcile`, scheduled by Vercel Cron at `0 * * * *`
(hourly). Gated by `Authorization: Bearer ${CRON_SECRET}` header set in
the Vercel Cron config — anything else returns 401.

Logic:

1. Fetch `GET ${WC_API_URL}/orders?status=completed&after=<48h-ago-iso>&per_page=100` with basic auth (consumer key + secret).
2. Paginate via `X-WP-TotalPages` header.
3. For each order, for each line item whose SKU is in our config table:
   - Acquire the same advisory lock as the webhook path.
   - Count actual cards via `countCardsForWcOrder`.
   - Compute expected from line items + quantities.
   - If actual < expected: create the missing cards via the same code path the webhook uses.
4. Log a summary at end: `[cron wc-reconcile] done { ordersScanned, cardsHealed }`.

Lookback (48h) is wide enough to catch failures that lasted overnight,
short enough to keep the WC API call cheap.

### Tests (rule 18 — non-negotiable)

Unit (PGlite + the existing test harness):

1. **HMAC verification**
   - Valid signature → handler proceeds.
   - Invalid signature → 401, no DB writes.
   - Missing header → 401.
2. **Topic filter**
   - `order.created` with `status=completed` → processes.
   - `order.updated` with `status=completed` → processes.
   - `order.updated` with `status=processing` → 200, no writes.
   - `customer.created` → 200, no writes.
3. **SKU mapping**
   - One line item, known SKU → 1 card created.
   - One line item quantity=3, known SKU → 3 cards created.
   - Two line items, one known one unknown → 1 card created.
   - Unknown SKU only → 0 cards, 200, log entry.
4. **Customer resolution**
   - Existing customer by phone → card linked, no new customer row.
   - New customer (phone not seen) → customer row created with WC info, source='website'.
   - Phone differing only in formatting → matches existing via normalization.
   - Phone empty → `wc_webhook_failures` row, no card, 200.
5. **Idempotency**
   - Same delivery_id twice → second call returns 200, no second card.
   - Same wc_order_id reached via webhook then reconciliation → reconciliation sees the cards exist, creates 0 new.
   - Webhook handler crashes mid-transaction → rerun creates correct N cards (Postgres rolled back the partial work).
6. **Validity override per SKU**
   - SKU config with `validityDays = 30` → card has `expiresAt = now + 30d`.
   - SKU config with `validityDays = null` → card has `expiresAt = null` (forever).
7. **Reconciliation**
   - WC has 3 orders; we have cards for 2 → reconcile creates the third.
   - WC has 3 orders; we have cards for all 3 → reconcile creates 0, returns summary.
   - Missing WC creds → cron returns 503, never throws.

Bug-fix discipline (rule 18): for any production webhook bug, write a
failing test against the old code first, fix, watch it pass.

### Plan unchanged for existing modules

- `createPunchCard` already accepts `wcOrderId` (verified at
  `packages/db/src/cards.ts:117`). No signature change.
- `customers.phone` already unique + normalized (`packages/db/src/schema/customers.ts:33`).
- WP user sync (`apps/api/src/lib/wp-sync.ts`) stays as-is — independent of
  this flow. New customers created from WC webhook will get a WP user
  created via the existing fire-and-forget path if `WP_BASE_URL` is set.

## WP/WC side configuration (the part you do in WP admin)

1. **WooCommerce → Settings → Advanced → REST API → Add key.**
   - Description: "Memesh reconciliation cron"
   - User: a dedicated WP user (not your admin)
   - Permissions: Read
   - Save → copy `Consumer key` + `Consumer secret` once (never shown again).
2. **WooCommerce → Settings → Advanced → Webhooks → Add webhook.**
   - Name: "Memesh card provisioning"
   - Status: Active
   - Topic: **Order updated** (not "created" — completion is a status update on PayPlus/Tranzila redirect flows)
   - Delivery URL: `https://<vercel-domain>/api/webhooks/woocommerce/order`
   - Secret: generate 64 hex chars (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) — paste into WC, also set as `WC_WEBHOOK_SECRET` in Vercel env vars (production scope).
   - API Version: WP REST API Integration v3
   - Save.
3. **Verify the checkout flow.** Buy SKU 1004 yourself with a test phone:
   - WC creates the order, status moves to `completed` after payment.
   - WC webhook fires, hits the API, card is created.
   - You see the card in the admin under that customer.
4. **DNS:** add `api.memesh.co.il` CNAME → `cname.vercel-dns.com` in Cloudflare (proxy OFF for cert issuance). Add the domain in Vercel project settings. Re-point the webhook URL to the custom domain once it's live. Cosmetic — not required for v1 to work.

## Settings audit (rule 15)

Exposed in admin settings layer:

| Setting | Default | Why exposed |
|---|---|---|
| `wcWebhookEnabled` | true | Kill-switch if the integration starts misbehaving. |
| `wcReconciliationEnabled` | true | Same, for the cron. |
| `wcReconciliationLookbackHours` | 48 | Lets us widen the net during an incident. |

Intentionally **not** exposed in v1:

- The HMAC secret (env var only, rotation flow comes later).
- The product → card-config mapping (admin UI for this is a v2 feature once we have a second SKU).
- The reconciliation cron schedule (hardcoded hourly; if we need to change, redeploy).

## Security (rule 13)

- **HMAC-SHA256 against the raw body**, timing-safe compare, base64 decode before compare.
- **Secrets in Vercel env vars only**, never committed. Production scope only — preview deploys do not receive the prod webhook secret (their secret is different; we configure a separate "preview" webhook in WC if/when we need it).
- **WC consumer key is Read-only.** The reconciliation cron only reads orders. It does not modify WC state.
- **Vercel Cron secret gate** on `/cron/*`. Reject anything that doesn't match the `Authorization: Bearer ...` header set in Vercel Cron config.
- **No PII in logs** beyond what we already log (customer id, card serial, order id). Specifically: never log the raw billing payload at info level. Failure rows in `wc_webhook_failures` may store the payload (jsonb) for human review — protect that table with admin-only access.
- **Rate-limit the webhook endpoint** at 60 req/min per IP. WC won't burst that fast; protects against a leaked URL being probed.
- **TLS only.** Vercel handles this for us. Document: never bypass TLS for "local testing" against production WC.
- **Replay window:** WC delivery IDs in `wc_processed_webhooks` are kept forever (cheap; ~50 rows/day max). Replays from a leaked log get 200'd as already-processed but don't create cards.
- **Webhook payload reveals phone + name** in transit. Cloudways → Vercel is HTTPS over the public internet. Acceptable; the data is the same data the user typed into a public checkout form.
- **WP user creation from WC orders:** if `WP_BASE_URL` is set, new customers get a WP user via the existing `syncCustomerToWp`. The synthetic email format (`<phone>@memesh.local`) is intentional — these users can't log into WP. Confirm this is desired for WC-purchased customers (their billing email is real and arguably should be preferred).

## Observability (rule 14)

All logs use the `[webhook wc]` and `[cron wc-reconcile]` namespaces. Per
step:

| Event | Level | Fields |
|---|---|---|
| `[webhook wc] received` | info | deliveryId, topic, orderId, status |
| `[webhook wc] signature_invalid` | warn | deliveryId, ip |
| `[webhook wc] duplicate` | info | deliveryId, orderId |
| `[webhook wc] ignored_non_completed` | info | deliveryId, orderId, status |
| `[webhook wc] failure_recorded` | warn | deliveryId, orderId, reason |
| `[webhook wc] card_created` | info | cardId, serial, customerId, wcOrderId, sku |
| `[webhook wc] done` | info | deliveryId, processedCount, durationMs |
| `[webhook wc] exception` | error | deliveryId, err.message, err.stack |
| `[cron wc-reconcile] start` | info | lookbackHours |
| `[cron wc-reconcile] order_healed` | info | wcOrderId, expected, actual, created |
| `[cron wc-reconcile] done` | info | ordersScanned, cardsHealed, durationMs |
| `[cron wc-reconcile] api_error` | error | status, body.slice(0,200) |

Every log includes the Fastify `request.id` so cross-event tracing works.

## Open questions

All v1-blocking questions have been resolved (see Locked Decisions
table). Remaining items are observational and do not block ship:

- **Does the WC checkout currently expose a marketing-consent checkbox?**
  If yes, capture it. If no, leave `marketingConsentAt` null and add the
  checkbox as a future WP task. Either way the implementation handles both
  cases — this just affects how many new customers come in with consent
  pre-recorded.
- **Existing "Event Tickets" plugin sunset.** This plan replaces it for
  new purchases. Existing customers with un-redeemed Event-Tickets codes
  (visible in `View Entrance Logs`) will continue to work in the old
  plugin until either (a) they're fully redeemed, or (b) we run a
  one-time migration to import them as `punch_cards` rows. Migration is a
  separate plan, not blocked by this one.

## Out of scope (v1)

- API → WC sync (cancel-card → refund the WC order, etc.). v2 question.
- Multi-SKU support (works because of the config table, but only one row exists for v1).
- Variable products / product variations in WC.
- Refund-from-WC propagation.
- Admin UI for the WC config table (v2).
- Customer-facing "my orders" view that joins WC orders with cards (lives in customer portal, not this plan).
- A separate webhook for "subscription renewal" if WC Subscriptions ever enters the picture.

## Implementation sequence

When approved, the work splits cleanly:

1. DB migration + seed (1 PR). Tests green.
2. Webhook route + Fastify content-type parser + HMAC verify (1 PR). Tests green.
3. Reconciliation cron + Vercel cron config (1 PR). Tests green.
4. WP/WC side configuration (Yoav, in WC admin UI). Buy a test כרטיסייה to verify end-to-end.
5. Settings audit additions (small PR — kill-switches in admin settings UI).

No PR ships without unit tests for the change (rule 18) and observability
logs at every step (rule 14).
