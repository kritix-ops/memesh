# Rounds (סבבים) — WooCommerce / WordPress handoff for Yanay

Date: 2026-07-01
Audience: Yanay (WooCommerce / WordPress side)
Our side status: the booking engine, personal area, swap, and cancel+refund are built, tested, and merged to `main`. Nothing below is blocked on us. This doc is the list of things that live on the WP/WC side, plus the four values we need back from you.

The whole design follows the super-brief §4. One rule drives all of it: **the rounds system owns stock, WooCommerce is only the payment pipe.** All round products are `manage_stock=false`. A seat is reserved by calling our hold endpoint at selection time, before payment. The barcode is created at payment.

API base URL for everything below: `https://api.memesh.co.il` (routes are at the root, there is no `/api` prefix on this domain).

---

## Part A — what you build in WooCommerce / WordPress

### A1. Products (§4.1)

Four products, all with **Manage stock = OFF** (we are the source of truth, WC must never block a sale on its own stock count):

| ID | Name (he) | Price | Tag | Used by |
|----|-----------|-------|-----|---------|
| 1001 | כרטיס כניסה לילד/ה יחיד/ה + מבוגר/ת מלווה | ₪55 | `single` | rounds |
| 1002 | כרטיס כניסה לתינוק/ת + מבוגר/ת מלווה | ₪45 | `single` | rounds |
| 1003 | כרטיס כניסה למלווה שני/ה | ₪12 | `single` | rounds (add-on) |
| 1004 | כרטיסייה (12 כניסות במחיר 10) | ₪550 | `multi` | punch card, separate flow — NOT rounds |

The base ticket (1001 or 1002) already includes one accompanying adult. 1003 is a **second** companion added onto the same child. It is not a separate seat.

### A2. The round picker (front-end JS on the product / booking page)

Read live availability from our public endpoint and render the times:

```
GET https://api.memesh.co.il/rounds/availability?date=YYYY-MM-DD
→ { "date": "...", "rounds": [
     { "roundInstanceId": "<uuid>", "label": "...", "startTime": "16:00",
       "endTime": "18:00", "capacity": 30, "available": 12, "isClosed": false }, ... ] }
```

Show only rounds where `available > 0` and `isClosed === false`. Keep the chosen `roundInstanceId` — you send it to the hold call next. This endpoint is public and rate limited; do not put the shared secret on it.

### A3. Reserve the seat at selection (§3.2, §4.2 step 1) — server-side call

The moment the shopper picks a round and gives their details (phone + name), reserve the seat by calling our hold endpoint **from PHP** (server-side, because it carries the shared secret — never expose the secret in browser JS):

```
POST https://api.memesh.co.il/rounds/hold/wc
Header: Authorization: Bearer <WP_HANDOFF_SHARED_SECRET>
Body (JSON):
{
  "roundInstanceId": "<uuid from availability>",
  "ticketType": "child_over_walking",        // 1001 → child_over_walking, 1002 → child_under_walking
  "additionalCompanions": 0,                   // 1 if the cart also has product 1003, else 0
  "customerHint": {
    "phone": "0501234567",                     // the shopper's phone (Israeli format)
    "firstName": "...",
    "lastName": "...",
    "email": "..."                             // optional
  }
}
→ 200 { "holdId": "<uuid>", "expiresAt": "2026-07-11T13:15:00Z" }
```

Notes:
- The hold lasts 15 minutes (configurable from our admin). If the shopper takes longer, re-hold before checkout.
- `phone` is the identity key. Use the SAME phone they will enter at WC billing, so the booking is tied to the customer who pays. We resolve or create the customer from this phone, exactly like the existing card order flow.
- Cart mapping: 1001 → `child_over_walking`; 1002 → `child_under_walking`; adding 1003 → set `additionalCompanions: 1` on that child's hold. 1003 is never its own hold.
- Error responses: `404` (no such round instance), `409` (round closed or full — show "this time just filled, pick another"), `401` (wrong/missing secret), `503` (secret not set on our side yet).

### A4. Carry the hold into the order line item (§4.2 step 2)

Persist the hold id onto the WC line item so it reaches the order. The only field our mint reads is `_memesh_hold_id`; the rest are for your own display/debugging:

```
_memesh_hold_id               = <holdId>          (REQUIRED)
_memesh_round_instance_id     = <roundInstanceId>
_memesh_slot_label            = <label>
_memesh_ticket_type           = child_over_walking | child_under_walking
_memesh_additional_companions = 0 | 1
```

Use `woocommerce_checkout_create_order_line_item` to write these onto the order item (same pattern as the existing gift meta `_memesh_gift_recipient_*`).

### A5. Mint on payment success (§4.2 steps 4-5) — reuse the existing handoff

This is the plugin you already run for cards. Nothing new to build here — once the order line items carry `_memesh_hold_id`, our mint handles rounds automatically. On the thank-you page:

```
POST https://api.memesh.co.il/auth/customer/wc-handoff/mint
Header: Authorization: Bearer <WP_HANDOFF_SHARED_SECRET>
Body: { orderId, phone, email, source: "wc_checkout", order: <full order payload incl. line-item meta_data> }
→ { token }   then redirect to  https://my.memesh.co.il/checkout-complete?token=<token>
```

Our mint now confirms the round booking and creates its barcode inline here, so the customer sees the barcode the instant they land in their personal area.

### A6. Order webhook (safety net, §4.3)

You already have this for cards. Confirm it is pointed at our URL and uses the shared secret. It now ALSO mints rounds from `_memesh_hold_id`, and it is idempotent (thank-you handoff + webhook both firing is safe, no double booking):

```
WooCommerce → Settings → Advanced → Webhooks → Add webhook
  Status:       Active
  Topic:        Order updated
  Delivery URL: https://api.memesh.co.il/webhooks/woocommerce/order
  Secret:       <must equal our WC_WEBHOOK_SECRET>
```

### A7. WC REST API key WITH refund permission (for cancel + auto-refund, §6.2)

Cancellation refunds the customer automatically. That needs a **Read/Write** REST key (the existing reconciliation key is Read-only and will NOT work for refunds):

```
WooCommerce → Settings → Advanced → REST API → Add key
  Description: Memesh rounds (refunds)
  Permissions: Read/Write      ← write is required for refunds
  → copy Consumer key + Consumer secret and send them to us
```

### A8. CONFIRM the payment gateway can refund via API (§6.2) — this is the one real unknown

Our cancel calls WooCommerce `POST /orders/{id}/refunds` with `api_refund: true`, which asks WooCommerce to push the refund to the gateway (Meshulam / Grow). **This only actually returns money if the gateway's WC plugin implements programmatic refunds** (`process_refund()`).

Please confirm with the gateway/plugin: does Meshulam/Grow support API refunds through WooCommerce, yes or no?
- If YES: cancellation is fully automatic, done.
- If NO: our cancel will fail safely (the customer keeps their seat and sees "we could not process the refund, contact us"). We would then need a manual-refund process, and we should tell customers cancellation is "request a refund" rather than instant. We need this answer to set the right expectation and, if needed, build the manual fallback.

---

## Part B — four things we need back from you

1. **`WP_HANDOFF_SHARED_SECRET`** — the same shared secret the card handoff already uses. The new `/rounds/hold/wc` uses it too. Confirm it is the same value, or send the value.
2. **WC REST Read/Write consumer key + secret** (from A7) — for `WC_API_CONSUMER_KEY` / `WC_API_CONSUMER_SECRET`.
3. **Webhook confirmation** — that it points at `https://api.memesh.co.il/webhooks/woocommerce/order` with a secret matching our `WC_WEBHOOK_SECRET`.
4. **Gateway refund answer** (A8) — yes or no on Meshulam/Grow API refunds.

Env vars we set on our side (api.memesh.co.il Vercel project), for reference: `WP_HANDOFF_SHARED_SECRET`, `WC_WEBHOOK_SECRET`, `WC_API_URL` (= `https://memesh.co.il/wp-json/wc/v3`), `WC_API_CONSUMER_KEY`, `WC_API_CONSUMER_SECRET`, `CRON_SECRET`.

---

## Part C — what is already done on our side (so the picture is complete)

- Availability, race-safe hold (atomic, cannot oversell), 15-min TTL with a per-minute sweeper.
- Two hold front doors: customer-session (`/rounds/hold`, for the personal area) and WooCommerce (`/rounds/hold/wc`, the one you call).
- Idempotent mint with HMAC barcode; fires on the thank-you handoff (primary) and the webhook (backstop).
- Personal area (`my.memesh.co.il`): the customer sees their rounds and barcodes.
- Change time (swap): move to another available round on the same day; the old barcode is invalidated.
- Cancel + auto-refund: refund is confirmed BEFORE the seat is released; if the refund cannot be confirmed the seat is kept (money-safe).
- WC order reconciliation cron (catches any webhook the store missed).

## Part D — honest open items / risks

1. **Gateway refunds (A8)** — the single blocking unknown for the cancel feature. Everything else works regardless.
2. **Companion mapping** — confirm product 1003 = `additionalCompanions: 1` on the child's hold, not a standalone seat. A companion does not consume a child seat from the pool.
3. **Phone consistency** — the hold `customerHint.phone` should equal the WC billing phone, or the booking's customer and the order's buyer diverge. Prefill both from the same field.
4. **Punch-card rounds** (pay for a round with a punch instead of cash, §3.4) — not built yet. It reuses the hold flow with a punch redemption instead of WC payment, and is a separate piece from the WC purchase above.
5. **Waitlist + reminders** (§8, §9) — separate spec sections, not part of this purchase/management flow.
