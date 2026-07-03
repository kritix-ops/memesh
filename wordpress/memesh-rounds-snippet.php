<?php
// Memesh Rounds — WP Code Snippets version (paste WITHOUT this opening <?php line).
//
// Canonical copy of the snippet that lives in WP Admin → Snippets → "Memesh
// Rounds". WP holds the runtime copy in its DB; this file is the source of
// truth for review/diff. When updating WP, paste everything below the CONFIG
// note and keep the real shared secret in MEMESH_SHARED_KEY (never commit it).
//
// What it does:
//   - Injects a round picker + paid-companion checkbox on the entry products.
//   - Punch-card upsell notice when a 2nd entry ticket is added.
//   - Holds the seat at checkout via /rounds/hold/wc and tags the order.
//   - Rounds mandatory ONLY when the rounds system is on: global switch via
//     GET /rounds/enabled (5-min transient) AND per-date via availability's
//     roundsRequired (60s transient per date). Off → plain product sale.

// ---- CONFIG ----
define('MEMESH_API_BASE',              'https://api.memesh.co.il');
define('MEMESH_SHARED_KEY',            'PASTE_WP_HANDOFF_SHARED_SECRET_HERE');
define('MEMESH_PUNCH_CARD_PRODUCT_ID', 306);

function memesh_ticket_type_for_product($product_id) {
    $map = [
        300 => 'child_over_walking',   // כרטיס כניסה לילד + מלווה
        304 => 'child_under_walking',  // תינוק + מלווה
    ];
    return $map[$product_id] ?? null;
}
// ----------------

function memesh_is_round_product($product_id) {
    return memesh_ticket_type_for_product($product_id) !== null;
}

/**
 * Is the rounds system in use at all? Cached 5 minutes. On an API error we
 * treat rounds as ENABLED (checkout would fail at the hold anyway) and cache
 * only 1 minute so recovery is quick.
 */
function memesh_rounds_enabled() {
    $cached = get_transient('memesh_rounds_enabled');
    if ($cached !== false) return $cached === 'yes';
    $res = wp_remote_get(MEMESH_API_BASE . '/rounds/enabled', ['timeout' => 5]);
    if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {
        set_transient('memesh_rounds_enabled', 'yes', 60);
        return true;
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    $enabled = !empty($data['enabled']);
    set_transient('memesh_rounds_enabled', $enabled ? 'yes' : 'no', 300);
    return $enabled;
}

/**
 * Are rounds required on a specific date? The admin can switch specific days
 * off (free play). Mirrors availability's roundsRequired. Cached 60s per date.
 * Fails toward "required" like the global check.
 */
function memesh_rounds_required_for_date($date) {
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) return true;
    $key = 'memesh_rounds_req_' . $date;
    $cached = get_transient($key);
    if ($cached !== false) return $cached === 'yes';
    $res = wp_remote_get(MEMESH_API_BASE . '/rounds/availability?date=' . rawurlencode($date), ['timeout' => 5]);
    if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {
        set_transient($key, 'yes', 60);
        return true;
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    $required = !isset($data['roundsRequired']) || !empty($data['roundsRequired']);
    set_transient($key, $required ? 'yes' : 'no', 60);
    return $required;
}

/** One-seat-per-line: quantity locked to 1 on the product page. */
add_filter('woocommerce_is_sold_individually', function ($sold, $product) {
    return memesh_is_round_product($product->get_id()) ? true : $sold;
}, 10, 2);

/** Round picker + companion card on the product page. */
add_action('woocommerce_before_add_to_cart_button', function () {
    global $product;
    if (!$product || !memesh_is_round_product($product->get_id())) return;
    if (!memesh_rounds_enabled()) return; // rounds off — plain product
    ?>
    <div class="memesh-round-picker">
        <label class="memesh-field">
            <span class="memesh-field-label">בחירת תאריך</span>
            <input type="date" id="memesh-date" name="memesh_date" required
                   min="<?php echo esc_attr(date('Y-m-d')); ?>" />
        </label>
        <label class="memesh-field" id="memesh-round-field">
            <span class="memesh-field-label">בחירת סבב</span>
            <select id="memesh-round" name="memesh_round_instance_id" required>
                <option value="">— בחרו תאריך תחילה —</option>
            </select>
        </label>

        <div class="memesh-companion-card">
            <label class="memesh-companion-label">
                <input type="checkbox" id="memesh-extra-companion" name="memesh_extra_companion" value="1" />
                <div class="memesh-companion-content">
                    <div class="memesh-companion-header">
                        <strong>הוסף מלווה נוסף</strong>
                        <span class="memesh-companion-price">+₪12</span>
                    </div>
                    <div class="memesh-companion-note">
                        המחיר הבסיסי כולל מלווה אחד. הוסיפו מלווה שני אם באים שני מבוגרים.
                    </div>
                </div>
            </label>
        </div>

        <div id="memesh-round-msg" class="memesh-round-msg"></div>
    </div>
    <script>
    (function () {
        var api = <?php echo json_encode(MEMESH_API_BASE); ?>;
        var dateEl = document.getElementById('memesh-date');
        var roundEl = document.getElementById('memesh-round');
        var roundField = document.getElementById('memesh-round-field');
        var msgEl = document.getElementById('memesh-round-msg');
        if (!dateEl) return;
        dateEl.addEventListener('change', function () {
            roundEl.innerHTML = '<option value="">טוען…</option>';
            roundEl.required = true;
            roundField.style.display = '';
            msgEl.textContent = '';
            msgEl.style.color = '#a23a3a';
            fetch(api + '/rounds/availability?date=' + encodeURIComponent(dateEl.value))
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    var open = (data.rounds || []).filter(function (x) { return x.available > 0 && !x.isClosed; });
                    var optional = data.roundsRequired === false;
                    if (optional && open.length === 0) {
                        // Rounds are off for this date — free play, nothing to pick.
                        roundEl.innerHTML = '<option value=""></option>';
                        roundEl.required = false;
                        roundField.style.display = 'none';
                        msgEl.style.color = '#5a7a3a';
                        msgEl.textContent = 'בתאריך זה הכניסה חופשית — אין צורך בבחירת סבב.';
                        return;
                    }
                    if (open.length === 0) {
                        roundEl.innerHTML = '<option value="">אין סבבים פנויים בתאריך זה</option>';
                        return;
                    }
                    var options = open.map(function (x) {
                        return '<option value="' + x.roundInstanceId + '">' + x.label + ' ' +
                               x.startTime + '–' + x.endTime + ' (' + x.available + ' פנויים)</option>';
                    }).join('');
                    if (optional) {
                        // Free-play day with round windows: picking a round is a
                        // choice, not a requirement.
                        roundEl.required = false;
                        roundEl.innerHTML = '<option value="">בלי סבב — כניסה חופשית</option>' + options;
                        msgEl.style.color = '#5a7a3a';
                        msgEl.textContent = 'בתאריך זה אפשר להיכנס חופשי או לשריין סבב — לבחירתכם.';
                        return;
                    }
                    roundEl.innerHTML = '<option value="">— בחרו סבב —</option>' + options;
                })
                .catch(function () { msgEl.textContent = 'לא ניתן לטעון סבבים כרגע.'; });
        });
    })();
    </script>
    <?php
});

/** Styling for the picker, the companion card, and the upsell notice. */
add_action('wp_head', function () {
    ?>
    <style>
    .memesh-round-picker { margin: 18px 0; display: flex; flex-direction: column; gap: 12px; }
    .memesh-field { display: flex; flex-direction: column; gap: 6px; }
    .memesh-field-label { font-size: 14px; font-weight: 500; color: #333; }
    .memesh-field input,
    .memesh-field select {
        padding: 9px 12px; border: 1px solid #ccc; border-radius: 6px;
        font-size: 15px; background: #fff; width: 100%; box-sizing: border-box;
    }
    .memesh-round-msg { font-size: 13px; color: #a23a3a; min-height: 16px; }

    .memesh-companion-card {
        margin: 4px 0; padding: 14px 16px;
        background: #fbf7f0; border: 1px solid #d9c8a8; border-radius: 8px;
        transition: background 0.15s;
    }
    .memesh-companion-card:hover { background: #f7f1e5; }
    .memesh-companion-label {
        display: flex; align-items: flex-start; gap: 12px;
        cursor: pointer; margin: 0;
    }
    .memesh-companion-label input[type="checkbox"] {
        margin-top: 3px; flex-shrink: 0;
        width: 18px; height: 18px; cursor: pointer;
    }
    .memesh-companion-content { flex: 1; min-width: 0; }
    .memesh-companion-header {
        display: flex; justify-content: space-between;
        align-items: baseline; gap: 8px;
    }
    .memesh-companion-header strong { font-size: 15px; color: #333; }
    .memesh-companion-price {
        font-size: 15px; font-weight: 600; color: #a25a1c; white-space: nowrap;
    }
    .memesh-companion-note {
        color: #666; font-size: 13px; margin-top: 6px; line-height: 1.5;
    }

    .woocommerce-message .memesh-upsell,
    .woocommerce-info    .memesh-upsell,
    .woocommerce-error   .memesh-upsell,
    .memesh-upsell { line-height: 1.65; padding: 6px 0; }
    .memesh-upsell-title { display: block; font-size: 16px; font-weight: 600; margin-bottom: 6px; }
    .memesh-upsell-cta {
        display: inline-block; margin-top: 10px; padding: 9px 18px;
        background: #b18a5a; color: #fff !important; border-radius: 6px;
        text-decoration: none; font-weight: 500;
    }
    .memesh-upsell-cta:hover { background: #9a7449; }
    </style>
    <?php
});

/** Add-to-cart validation: require a round only when rounds are in use (globally AND for the chosen date). */
add_filter('woocommerce_add_to_cart_validation', function ($passed, $product_id) {
    if (!memesh_is_round_product($product_id)) return $passed;
    if (!memesh_rounds_enabled()) return $passed; // plain-product mode

    $date = isset($_POST['memesh_date']) ? sanitize_text_field($_POST['memesh_date']) : '';
    if ($date !== '' && !memesh_rounds_required_for_date($date)) {
        return $passed; // this specific date is rounds-off — free play
    }

    if (empty($_POST['memesh_round_instance_id']) || $date === '') {
        wc_add_notice('בחירת תאריך וסבב נדרשת לפני הוספה לסל.', 'error');
        return false;
    }

    $existing = null;
    foreach (WC()->cart->get_cart() as $item) {
        if (memesh_is_round_product($item['product_id'])) {
            $existing = (int) $item['product_id'];
            break;
        }
    }
    if ($existing) {
        $punch_url = get_permalink(MEMESH_PUNCH_CARD_PRODUCT_ID);
        $msg  = '<div class="memesh-upsell">';
        $msg .= '<span class="memesh-upsell-title">מתכננים לבוא יותר מפעם אחת?</span>';
        $msg .= 'כרטיסייה של 12 כניסות עולה ₪550, כלומר ₪45.83 לכניסה במקום ₪55. ';
        $msg .= 'משתלמת מ-10 ביקורים ומעלה, ומאפשרת לקבוע סבב עתידי בכל עת.';
        if ($punch_url) {
            $msg .= '<br><a class="memesh-upsell-cta" href="' . esc_url($punch_url) . '">לרכישת כרטיסייה →</a>';
        }
        $msg .= '</div>';
        wc_add_notice($msg, 'notice');

        if ($existing === (int) $product_id) return false;
    }
    return $passed;
}, 10, 2);

/** Carry the choices into the cart item (only when a round was actually chosen). */
add_filter('woocommerce_add_cart_item_data', function ($data, $product_id) {
    if (!memesh_is_round_product($product_id)) return $data;
    if (empty($_POST['memesh_round_instance_id'])) return $data; // plain-product / off-date mode
    $data['memesh_round_instance_id'] = sanitize_text_field($_POST['memesh_round_instance_id']);
    $data['memesh_date']              = sanitize_text_field($_POST['memesh_date']);
    $data['memesh_ticket_type']       = memesh_ticket_type_for_product($product_id);
    $data['memesh_extra_companion']   = !empty($_POST['memesh_extra_companion']) ? 1 : 0;
    return $data;
}, 10, 2);

/**
 * The extra companion is charged as a FEE row, not a silent price bump, so
 * "מלווה נוסף +₪12" shows as its own line in the cart totals, checkout,
 * order, emails, and receipt (Yoav 2026-07-02). The ticket line keeps its
 * real product price.
 */
add_action('woocommerce_cart_calculate_fees', function ($cart) {
    if (is_admin() && !defined('DOING_AJAX')) return;
    $count = 0;
    foreach ($cart->get_cart() as $item) {
        if (!empty($item['memesh_extra_companion'])) $count += 1;
    }
    if ($count > 0) {
        $label = $count > 1 ? sprintf('מלווה נוסף × %d', $count) : 'מלווה נוסף';
        $cart->add_fee($label, 12 * $count, false);
    }
});

/**
 * The custom cart template renders only the line-item name and prices — it
 * skips WC item meta and fee rows. Fold the companion (and the round date)
 * into the name itself so every cart design shows them (Yanay 2026-07-04).
 */
add_filter('woocommerce_cart_item_name', function ($name, $cart_item) {
    $extras = [];
    if (!empty($cart_item['memesh_date'])) {
        $extras[] = 'סבב ' . $cart_item['memesh_date'];
    }
    if (!empty($cart_item['memesh_extra_companion'])) {
        $extras[] = 'כולל מלווה נוסף (+₪12)';
    }
    if ($extras) {
        $name .= ' — ' . implode(' · ', $extras);
    }
    return $name;
}, 10, 2);

/** Show the round + companion in cart / checkout. */
add_filter('woocommerce_get_item_data', function ($items, $cart_item) {
    if (!empty($cart_item['memesh_round_instance_id'])) {
        $items[] = ['name' => 'סבב', 'value' => esc_html($cart_item['memesh_date'])];
    }
    if (!empty($cart_item['memesh_extra_companion'])) {
        $items[] = ['name' => 'מלווה נוסף', 'value' => 'כן (+₪12)'];
    }
    return $items;
}, 10, 2);

/** Reserve the seat(s) at checkout — only when a round was chosen. */
add_action('woocommerce_checkout_create_order_line_item', function ($item, $cart_item_key, $values, $order) {
    if (empty($values['memesh_round_instance_id'])) return;

    $phone = $order->get_billing_phone();
    $first = $order->get_billing_first_name();
    $last  = $order->get_billing_last_name();
    $email = $order->get_billing_email();
    if (!$phone || !$first) {
        throw new Exception('נדרשים שם וטלפון לאישור מקום בסבב.');
    }

    $body = [
        'roundInstanceId'      => $values['memesh_round_instance_id'],
        'ticketType'           => $values['memesh_ticket_type'],
        'additionalCompanions' => !empty($values['memesh_extra_companion']) ? 1 : 0,
        'customerHint'         => [
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
        throw new Exception('לא ניתן לאשר מקום כרגע. נסו שוב.');
    }
    $code = wp_remote_retrieve_response_code($res);
    if ($code === 409) {
        throw new Exception('הסבב התמלא זה עתה. אנא בחרו סבב אחר.');
    }
    if ($code !== 200) {
        throw new Exception('לא ניתן לאשר מקום כרגע. נסו שוב.');
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if (empty($data['holdId'])) {
        throw new Exception('לא ניתן לאשר מקום כרגע. נסו שוב.');
    }

    $item->add_meta_data('_memesh_hold_id', $data['holdId'], true);
    $item->add_meta_data('_memesh_round_instance_id', $values['memesh_round_instance_id'], true);
    $item->add_meta_data('_memesh_ticket_type', $values['memesh_ticket_type'], true);
    $item->add_meta_data('_memesh_additional_companions', !empty($values['memesh_extra_companion']) ? 1 : 0, true);
}, 10, 4);
