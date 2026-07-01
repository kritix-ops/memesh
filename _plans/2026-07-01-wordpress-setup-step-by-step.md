# WooCommerce / WordPress setup — step by step

Date: 2026-07-01
For: you (info@flexelent.com), with access to Yanay's WP/WC.
Goal: connect the WooCommerce store to the finished rounds system so a shopper can pick a round, pay, and get a barcode — and get an auto-refund on cancel.

The rounds system (availability, holds, minting, barcodes, swap, cancel, waitlist, reminders) is already live at `https://api.memesh.co.il`. Everything below is the WordPress side.

Do the steps in order. Steps 1, 2, 4, 5, 6 are admin clicks. Step 3 is a plugin you paste in once. Step 7 is the test.

---

## Step 1 — Shared secret + Vercel env vars

The store authenticates to our API with a shared secret. Set it on both sides so they match.

1. Generate a secret (any 40+ random chars). On a Mac/Linux terminal: `openssl rand -hex 24`. Keep it somewhere safe.
2. Go to the **memesh-api** project on Vercel → Settings → Environment Variables. Add/confirm these (Production):

   | Name | Value |
   |------|-------|
   | `WP_HANDOFF_SHARED_SECRET` | the secret from above (must be ≥32 chars) |
   | `WC_WEBHOOK_SECRET` | a second random secret (used in Step 4) |
   | `WC_API_URL` | `https://memesh.co.il/wp-json/wc/v3` |
   | `WC_API_CONSUMER_KEY` | filled in Step 5 |
   | `WC_API_CONSUMER_SECRET` | filled in Step 5 |

   `CRON_SECRET` should already be set (the hold-sweep + reminder crons use it).
3. After adding, **redeploy** the memesh-api project so the new values load.

If `WP_HANDOFF_SHARED_SECRET` is already set (the card handoff uses it), reuse that exact value — don't change it.

---

## Step 2 — WooCommerce products

WP Admin → Products. Create or edit four products. For **every** one: Edit → Inventory tab → **untick "Manage stock"**. The rounds system owns the seat count; WooCommerce must never block a sale on its own stock.

| Product | Name (Hebrew) | Price | Notes |
|---------|---------------|-------|-------|
| Child entry | כרטיס כניסה לילד/ה + מבוגר/ת מלווה | ₪55 | the main round ticket |
| Baby entry | כרטיס כניסה לתינוק/ת + מבוגר/ת מלווה | ₪45 | round ticket for babies |
| Extra companion | כרטיס כניסה למלווה שני/ה | ₪12 | optional add-on (see note in Step 3) |
| Punch card | כרטיסייה – 12 כניסות | ₪550 | separate flow, NOT a round |

Write down the **product IDs** of the Child entry and Baby entry (hover the product in the list → the URL shows `post=NNNN`). You'll put them in the plugin config.

---

## Step 3 — The integration plugin

This adds a round picker to the entry-product pages, reserves the seat at checkout, and tags the order so our system can mint the booking.

1. WP Admin → Plugins → Plugin File Editor is fine, but cleaner: create a file `wp-content/plugins/memesh-rounds/memesh-rounds.php` with the content below (FTP or the hosting file manager).
2. Fill the three config constants at the top.
3. WP Admin → Plugins → activate **Memesh Rounds**.

```php
<?php
/**
 * Plugin Name: Memesh Rounds
 * Description: Round picker + seat hold + order tagging for the Memesh rounds system.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) exit;

// ---- CONFIG: fill these three ----
const MEMESH_API_BASE   = 'https://api.memesh.co.il';
const MEMESH_SHARED_KEY  = 'PASTE_WP_HANDOFF_SHARED_SECRET_HERE'; // same value as on Vercel
// Map WooCommerce product IDs to the round ticket type.
function memesh_ticket_type_for_product($product_id) {
    $map = [
        1234 => 'child_over_walking',  // <-- Child entry product ID
        5678 => 'child_under_walking', // <-- Baby entry product ID
    ];
    return $map[$product_id] ?? null;
}
// ----------------------------------

/** Is this product a round entry ticket? */
function memesh_is_round_product($product_id) {
    return memesh_ticket_type_for_product($product_id) !== null;
}

/** Round picker fields on the product page (date + round dropdown). */
add_action('woocommerce_before_add_to_cart_button', function () {
    global $product;
    if (!$product || !memesh_is_round_product($product->get_id())) return;
    ?>
    <div class="memesh-round-picker" style="margin:14px 0;display:flex;flex-direction:column;gap:8px">
        <label>בחרו תאריך:
            <input type="date" id="memesh-date" name="memesh_date" required
                   min="<?php echo esc_attr(date('Y-m-d')); ?>" />
        </label>
        <label>בחרו סבב:
            <select id="memesh-round" name="memesh_round_instance_id" required>
                <option value="">— בחרו תאריך תחילה —</option>
            </select>
        </label>
        <div id="memesh-round-msg" style="font-size:13px;color:#a23a3a"></div>
    </div>
    <script>
    (function () {
        var api = <?php echo json_encode(MEMESH_API_BASE); ?>;
        var dateEl = document.getElementById('memesh-date');
        var roundEl = document.getElementById('memesh-round');
        var msgEl = document.getElementById('memesh-round-msg');
        if (!dateEl) return;
        dateEl.addEventListener('change', function () {
            roundEl.innerHTML = '<option value="">טוען…</option>';
            msgEl.textContent = '';
            fetch(api + '/rounds/availability?date=' + encodeURIComponent(dateEl.value))
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    var open = (data.rounds || []).filter(function (x) { return x.available > 0 && !x.isClosed; });
                    if (open.length === 0) {
                        roundEl.innerHTML = '<option value="">אין סבבים פנויים ביום זה</option>';
                        return;
                    }
                    roundEl.innerHTML = '<option value="">— בחרו סבב —</option>' + open.map(function (x) {
                        return '<option value="' + x.roundInstanceId + '">' + x.label + ' ' +
                               x.startTime + '–' + x.endTime + ' (' + x.available + ' פנויים)</option>';
                    }).join('');
                })
                .catch(function () { msgEl.textContent = 'לא ניתן לטעון זמנים כרגע.'; });
        });
    })();
    </script>
    <?php
});

/** Require a round to be chosen before add-to-cart. */
add_filter('woocommerce_add_to_cart_validation', function ($passed, $product_id) {
    if (!memesh_is_round_product($product_id)) return $passed;
    if (empty($_POST['memesh_round_instance_id']) || empty($_POST['memesh_date'])) {
        wc_add_notice('בחרו תאריך וסבב לפני ההוספה לסל.', 'error');
        return false;
    }
    return $passed;
}, 10, 2);

/** Carry the chosen round into the cart item. */
add_filter('woocommerce_add_cart_item_data', function ($data, $product_id) {
    if (!memesh_is_round_product($product_id)) return $data;
    $data['memesh_round_instance_id'] = sanitize_text_field($_POST['memesh_round_instance_id']);
    $data['memesh_date'] = sanitize_text_field($_POST['memesh_date']);
    $data['memesh_ticket_type'] = memesh_ticket_type_for_product($product_id);
    return $data;
}, 10, 2);

/** Show the chosen round in the cart / checkout. */
add_filter('woocommerce_get_item_data', function ($items, $cart_item) {
    if (!empty($cart_item['memesh_round_instance_id'])) {
        $items[] = ['name' => 'סבב', 'value' => esc_html($cart_item['memesh_date'])];
    }
    return $items;
}, 10, 2);

/**
 * At order creation: reserve the seat for real via /rounds/hold/wc using the
 * billing details, and stamp the hold id onto the order line item. If the seat
 * is gone, stop checkout with a clear message (no oversell). Runs before payment.
 */
add_action('woocommerce_checkout_create_order_line_item', function ($item, $cart_item_key, $values, $order) {
    if (empty($values['memesh_round_instance_id'])) return;

    $phone = $order->get_billing_phone();
    $first = $order->get_billing_first_name();
    $last  = $order->get_billing_last_name();
    $email = $order->get_billing_email();
    if (!$phone || !$first) {
        throw new Exception('נדרשים שם וטלפון כדי לשריין מקום בסבב.');
    }

    $body = [
        'roundInstanceId' => $values['memesh_round_instance_id'],
        'ticketType'      => $values['memesh_ticket_type'],
        'customerHint'    => [
            'phone'     => $phone,
            'firstName' => $first,
            'lastName'  => $last ?: '-',
            'email'     => $email ?: null,
        ],
    ];
    $res = wp_remote_post(MEMESH_API_BASE . '/rounds/hold/wc', [
        'headers' => [
            'Authorization' => 'Bearer ' . MEMESH_SHARED_KEY,
            'Content-Type'  => 'application/json',
        ],
        'body'    => wp_json_encode($body),
        'timeout' => 15,
    ]);

    if (is_wp_error($res)) {
        throw new Exception('לא ניתן לשריין מקום כרגע. נסו שוב.');
    }
    $code = wp_remote_retrieve_response_code($res);
    if ($code === 409) {
        throw new Exception('הסבב התמלא בזמן ההזמנה. חזרו ובחרו זמן אחר.');
    }
    if ($code !== 200) {
        throw new Exception('לא ניתן לשריין מקום כרגע. נסו שוב.');
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if (empty($data['holdId'])) {
        throw new Exception('לא ניתן לשריין מקום כרגע. נסו שוב.');
    }

    // This is the ONLY field our system needs on the order.
    $item->add_meta_data('_memesh_hold_id', $data['holdId'], true);
    // Extras for your own reference (optional).
    $item->add_meta_data('_memesh_round_instance_id', $values['memesh_round_instance_id'], true);
    $item->add_meta_data('_memesh_ticket_type', $values['memesh_ticket_type'], true);
}, 10, 4);
```

**Notes**
- The "Extra companion" product (₪12) is optional and left out of the core flow. If Yanay wants a second paid companion tied to a round booking, that's a small follow-up — tell me and I'll extend the picker to set `additionalCompanions`.
- The hold is created at checkout (using billing phone/name), so no seat is locked while the shopper browses. At playground volume the only effect is a rare "just filled, pick another" at checkout — which is the oversell protection doing its job.
- The picker JS is intentionally plain so it works in any theme. If your theme hides `woocommerce_before_add_to_cart_button`, tell me the theme and I'll point it at the right hook.

---

## Step 4 — The order webhook (mints the booking)

This is what turns a paid order into a confirmed booking + barcode.

WP Admin → WooCommerce → Settings → Advanced → Webhooks → **Add webhook**:

- **Name:** Memesh rounds
- **Status:** Active
- **Topic:** Order updated
- **Delivery URL:** `https://api.memesh.co.il/webhooks/woocommerce/order`
- **Secret:** paste the exact `WC_WEBHOOK_SECRET` value from Step 1
- **API Version:** WP REST API Integration v3

Save. If you already have a "Memesh card provisioning" webhook pointing at the same URL with the same secret, you don't need a second one — the same webhook mints both cards and rounds.

---

## Step 5 — REST API key (for refunds)

Cancellation refunds go back through WooCommerce, which needs a write-capable key.

WP Admin → WooCommerce → Settings → Advanced → REST API → **Add key**:

- **Description:** Memesh rounds (refunds)
- **User:** an admin user
- **Permissions:** **Read/Write** (write is required for refunds)
- Generate → copy the **Consumer key** and **Consumer secret**.

Put them into the Vercel env vars from Step 1 (`WC_API_CONSUMER_KEY`, `WC_API_CONSUMER_SECRET`) and redeploy memesh-api. The existing reconciliation key is Read-only and will NOT work for refunds — use this new Read/Write one.

---

## Step 6 — Confirm the gateway can refund via API

This is the one thing outside WordPress. Our cancel calls WooCommerce's refund API with "push to gateway" on. That only moves money if the Meshulam/Grow WooCommerce plugin supports programmatic refunds.

Check the gateway plugin's settings/docs, or ask Meshulam/Grow support: **does your WooCommerce plugin support API refunds (process_refund)?**

- **Yes** → cancellation is fully automatic. Done.
- **No** → our cancel will fail safely (the customer keeps their seat and sees "couldn't refund, contact us"), and refunds must be done by hand. Tell me if it's "No" and I'll add a manual-refund fallback + adjust the customer wording.

---

## Step 7 — Test the whole flow

1. **Availability:** open `https://api.memesh.co.il/rounds/availability?date=YYYY-MM-DD` in a browser (a date with active rounds). You should see JSON with round times. (First create at least one round in the admin: `admin.memesh.co.il` → Rounds.)
2. **Picker:** open the Child entry product page. Pick a date → the round dropdown fills with open times.
3. **Buy:** pick a round, add to cart, check out with a real phone, and pay a test order.
4. **Booking appears:** within a few seconds, log into `my.memesh.co.il` with that phone → the round shows under "הסבבים שלי" with a barcode.
5. **Cancel + refund:** cancel it from the personal area (more than 24h before the round). Confirm the customer is refunded in WooCommerce → the order shows a refund. (If the gateway doesn't support API refunds, you'll instead see the "couldn't refund" message — that's Step 6.)
6. **Oversell:** set a round's capacity to 1 in the admin, buy it, then try to buy it again — the second checkout should be blocked with "just filled."

If any step fails, note which one and the error, and send it over.

---

## Appendix — what talks to what

| Action | Endpoint | Auth |
|--------|----------|------|
| Round picker reads availability | `GET /rounds/availability?date=` | none (public) |
| Reserve a seat at checkout | `POST /rounds/hold/wc` | `Bearer WP_HANDOFF_SHARED_SECRET` |
| Mint the booking after payment | `POST /webhooks/woocommerce/order` | HMAC `X-WC-Webhook-Signature` (`WC_WEBHOOK_SECRET`) |
| Refund on cancel | WooCommerce REST `orders/{id}/refunds` | `WC_API_CONSUMER_KEY/SECRET` (Read/Write) |

The customer manages bookings (change time, cancel, waitlist, punch-card booking) entirely in `my.memesh.co.il` — no WordPress involvement there.
