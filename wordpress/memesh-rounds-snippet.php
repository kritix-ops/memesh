<?php
// Memesh Rounds — WP Code Snippets version (paste WITHOUT this opening <?php line).
//
// Canonical copy of the snippet that lives in WP Admin → Snippets → "Memesh
// Rounds". WP holds the runtime copy in its DB; this file is the source of
// truth for review/diff. When updating WP, paste everything below the CONFIG
// note and keep the real shared secret in MEMESH_SHARED_KEY (never commit it).
//
// What it does:
//   - Injects a day-strip round picker + paid-companion checkbox on the entry
//     products: a month of days with availability dots (same look as the
//     customer dashboard, Yanay 2026-07-05), then the chosen day's rounds as
//     tappable rows. One /rounds/availability-range call feeds the whole
//     picker.
//   - Punch-card upsell notice when a 2nd entry ticket is added.
//   - Holds the seat at checkout via /rounds/hold/wc and tags the order.
//   - Rounds mandatory ONLY when the rounds system is on: global switch via
//     GET /rounds/enabled (5-min transient) AND per-date via availability's
//     roundsRequired (60s transient per date). Off → plain product sale.

// ---- CONFIG ----
define('MEMESH_API_BASE',              'https://api.memesh.co.il');
define('MEMESH_SHARED_KEY',            'PASTE_WP_HANDOFF_SHARED_SECRET_HERE');
define('MEMESH_PUNCH_CARD_PRODUCT_ID', 306);
// The ₪12 companion product. Must be PUBLISHED with catalog visibility
// "hidden" and price 12 — the snippet adds it to the cart automatically as a
// real line (the only thing every cart theme renders) and blocks buying it
// on its own.
define('MEMESH_COMPANION_PRODUCT_ID',  305);

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
        <div class="memesh-field-label">בחירת יום וסבב</div>
        <div class="memesh-strip" id="memesh-strip"></div>
        <div class="memesh-legend" id="memesh-legend" style="display:none">
            <span><i class="memesh-dot memesh-dot-ok"></i> הרבה מקום</span>
            <span><i class="memesh-dot memesh-dot-warn"></i> נשארו מעט</span>
            <span><i class="memesh-dot memesh-dot-full"></i> מלא</span>
            <span><i class="memesh-dot memesh-dot-free"></i> כניסה חופשית</span>
        </div>
        <div class="memesh-rounds" id="memesh-rounds"></div>

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

        <div id="memesh-round-msg" class="memesh-round-msg">טוען זמינות…</div>
        <input type="hidden" id="memesh-date" name="memesh_date" value="" />
        <input type="hidden" id="memesh-round" name="memesh_round_instance_id" value="" />
        <input type="hidden" id="memesh-round-times" name="memesh_round_times" value="" />
    </div>
    <script>
    // Day-strip picker (Yanay 2026-07-05): same look and logic as the customer
    // dashboard. One availability-range call renders a month of day chips with
    // status dots; tapping a day lists its rounds as rows; tapping a row fills
    // the hidden form fields the checkout hold already reads. All DOM is built
    // with createElement — nothing from the API is ever concatenated into HTML.
    (function () {
        var api = <?php echo json_encode(MEMESH_API_BASE); ?>;
        var stripEl = document.getElementById('memesh-strip');
        var legendEl = document.getElementById('memesh-legend');
        var roundsEl = document.getElementById('memesh-rounds');
        var msgEl = document.getElementById('memesh-round-msg');
        var dateEl = document.getElementById('memesh-date');
        var roundEl = document.getElementById('memesh-round');
        var timesEl = document.getElementById('memesh-round-times');
        if (!stripEl) return;

        var DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

        // The add-to-cart button stays disabled until the selection is valid —
        // the browser "required" guard went away with the old <select>, and a
        // reload-with-error beats nothing, but not-clickable beats both.
        function cartBtn() {
            var form = stripEl.closest ? stripEl.closest('form.cart') : null;
            return (form && form.querySelector('.single_add_to_cart_button')) ||
                   document.querySelector('.single_add_to_cart_button');
        }
        function setCanBuy(ok) {
            var btn = cartBtn();
            if (btn) btn.disabled = !ok;
        }
        function setMsg(text, good) {
            msgEl.textContent = text || '';
            msgEl.style.color = good ? '#5a7a3a' : '#a23a3a';
        }

        function openRounds(day) {
            return (day.rounds || []).filter(function (x) { return x.available > 0 && !x.isClosed; });
        }
        // Dot per day — same thresholds as the dashboard strip: red when
        // nothing is left, amber at a quarter or less, green otherwise.
        function dayDotClass(day) {
            var open = (day.rounds || []).filter(function (x) { return !x.isClosed; });
            if (open.length === 0) return day.roundsRequired ? 'memesh-dot-none' : 'memesh-dot-free';
            var cap = 0, avail = 0;
            open.forEach(function (x) { cap += x.capacity; avail += x.available; });
            if (avail === 0) return 'memesh-dot-full';
            if (cap > 0 && avail / cap <= 0.25) return 'memesh-dot-warn';
            return 'memesh-dot-ok';
        }

        function selectRound(row, id, times) {
            var rows = roundsEl.querySelectorAll('.memesh-round-row');
            for (var i = 0; i < rows.length; i += 1) rows[i].classList.remove('is-selected');
            row.classList.add('is-selected');
            roundEl.value = id;
            // The round's hours ride along so the cart / checkout / receipt can
            // show "סבב 05/07/2026 · 09:00–14:00", not just the date.
            timesEl.value = times;
            setMsg('');
            setCanBuy(true);
        }

        function roundRow(x, optional) {
            var row = document.createElement('button');
            row.type = 'button'; // inside form.cart — default type would submit
            row.className = 'memesh-round-row';
            var label = document.createElement('span');
            label.className = 'memesh-round-label';
            label.textContent = x.label + ' ' + x.startTime + '–' + x.endTime;
            var avail = document.createElement('span');
            avail.className = 'memesh-round-avail';
            avail.textContent = x.available + ' פנויים';
            row.appendChild(label);
            row.appendChild(avail);
            row.addEventListener('click', function () {
                selectRound(row, x.roundInstanceId, x.startTime + '–' + x.endTime);
                if (optional) setMsg('בתאריך זה אפשר גם להיכנס חופשי בלי סבב — לבחירתכם.', true);
            });
            return row;
        }

        function renderDay(day) {
            roundsEl.textContent = '';
            dateEl.value = day.date;
            roundEl.value = '';
            timesEl.value = '';
            var open = openRounds(day);
            var optional = day.roundsRequired === false;

            if (open.length === 0) {
                if (optional) {
                    setMsg('בתאריך זה הכניסה חופשית — אין צורך בבחירת סבב.', true);
                    setCanBuy(true); // server-side validation lets off-dates through
                } else {
                    setMsg('אין סבבים פנויים ביום זה — בחרו יום אחר.');
                    setCanBuy(false);
                }
                return;
            }

            if (optional) {
                // Free-play day with round windows: a round is a choice, not a
                // requirement — an explicit "no round" row keeps that obvious.
                var freeRow = document.createElement('button');
                freeRow.type = 'button';
                freeRow.className = 'memesh-round-row is-selected';
                var freeLabel = document.createElement('span');
                freeLabel.className = 'memesh-round-label';
                freeLabel.textContent = 'בלי סבב — כניסה חופשית';
                freeRow.appendChild(freeLabel);
                freeRow.addEventListener('click', function () {
                    selectRound(freeRow, '', '');
                    setMsg('בתאריך זה אפשר להיכנס חופשי או לשריין סבב — לבחירתכם.', true);
                });
                roundsEl.appendChild(freeRow);
                setMsg('בתאריך זה אפשר להיכנס חופשי או לשריין סבב — לבחירתכם.', true);
                setCanBuy(true);
            } else {
                setMsg('בחרו סבב כדי להמשיך.');
                setCanBuy(false);
            }
            open.forEach(function (x) { roundsEl.appendChild(roundRow(x, optional)); });
        }

        function dayChip(day, index) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'memesh-day-chip';
            var dow = document.createElement('span');
            dow.className = 'memesh-chip-dow';
            dow.textContent = index === 0 ? 'היום' : DOW[new Date(day.date + 'T12:00:00').getDay()] + '׳';
            var num = document.createElement('span');
            num.className = 'memesh-chip-num';
            num.textContent = String(Number(day.date.slice(8, 10)));
            var dot = document.createElement('i');
            dot.className = 'memesh-dot ' + dayDotClass(day);
            chip.appendChild(dow);
            chip.appendChild(num);
            chip.appendChild(dot);
            chip.addEventListener('click', function () {
                var chips = stripEl.querySelectorAll('.memesh-day-chip');
                for (var i = 0; i < chips.length; i += 1) chips[i].classList.remove('is-active');
                chip.classList.add('is-active');
                renderDay(day);
            });
            return chip;
        }

        setCanBuy(false); // nothing valid until the strip loads and a day is picked
        // 31 days = the API's max, covering the whole instance horizon — the
        // same reach the old free date input had.
        fetch(api + '/rounds/availability-range?days=31')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var days = data.days || [];
                if (days.length === 0) {
                    setMsg('אין סבבים פנויים כרגע. נסו שוב מאוחר יותר.');
                    return;
                }
                days.forEach(function (day, index) { stripEl.appendChild(dayChip(day, index)); });
                legendEl.style.display = '';
                var first = stripEl.querySelector('.memesh-day-chip');
                if (first) first.click(); // today preselected, its rounds visible
            })
            .catch(function () {
                setMsg('לא ניתן לטעון סבבים כרגע. רעננו את העמוד ונסו שוב.');
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
    .memesh-field-label { font-size: 14px; font-weight: 500; color: #333; }
    .memesh-round-msg { font-size: 13px; color: #a23a3a; min-height: 16px; }

    /* Day strip — same look as the customer dashboard picker. The chip and
       row buttons reset theme button styling hard: WP themes love to paint
       every <button>. */
    .memesh-strip {
        display: flex; gap: 6px; overflow-x: auto; padding: 2px 2px 4px;
        -webkit-overflow-scrolling: touch;
    }
    .memesh-strip .memesh-day-chip,
    .memesh-rounds .memesh-round-row {
        appearance: none; -webkit-appearance: none; box-shadow: none;
        margin: 0; text-transform: none; line-height: 1.3;
        font-family: inherit; cursor: pointer;
    }
    .memesh-day-chip {
        flex: 0 0 auto; min-width: 52px; padding: 8px 6px;
        border: 1.5px solid #e9e0d9; background: #fff; border-radius: 12px;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
    }
    .memesh-day-chip.is-active { border-color: #e7a33e; background: #fdf3e3; }
    .memesh-chip-dow { font-size: 10.5px; color: #636e72; font-weight: 600; }
    .memesh-chip-num { font-size: 15px; font-weight: 700; color: #2d3436; }
    .memesh-day-chip.is-active .memesh-chip-num { color: #b9772a; }
    .memesh-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    .memesh-dot-ok { background: #8fae5d; }
    .memesh-dot-warn { background: #e7a33e; }
    .memesh-dot-full { background: #cf7a6b; }
    .memesh-dot-free { background: #a9bac6; }
    .memesh-dot-none { background: #d9d2c9; }
    .memesh-legend {
        display: flex; flex-wrap: wrap; gap: 4px 12px; justify-content: center;
        font-size: 11.5px; color: #636e72;
    }
    .memesh-legend span { display: inline-flex; align-items: center; gap: 5px; }
    .memesh-rounds { display: flex; flex-direction: column; gap: 8px; }
    .memesh-rounds:empty { display: none; }
    .memesh-round-row {
        display: flex; justify-content: space-between; align-items: center;
        gap: 10px; width: 100%; padding: 10px 14px; font-size: 14px;
        border: 1.5px solid #e9e0d9; background: #fff; border-radius: 10px;
        text-align: right;
    }
    .memesh-round-row.is-selected { border-color: #e7a33e; background: #fdf3e3; }
    .memesh-round-label { font-weight: 600; color: #2d3436; }
    .memesh-round-avail { color: #636e72; font-size: 13px; white-space: nowrap; }

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

/** "05/07/2026 · 09:00–14:00" from the stored ISO date + times. Display only. */
function memesh_round_display($cart_item) {
    if (empty($cart_item['memesh_date'])) return '';
    $parts = explode('-', $cart_item['memesh_date']);
    $display = count($parts) === 3 ? "{$parts[2]}/{$parts[1]}/{$parts[0]}" : $cart_item['memesh_date'];
    if (!empty($cart_item['memesh_round_times'])) {
        $display .= ' · ' . $cart_item['memesh_round_times'];
    }
    return $display;
}

/** Carry the choices into the cart item (only when a round was actually chosen). */
add_filter('woocommerce_add_cart_item_data', function ($data, $product_id) {
    if (!memesh_is_round_product($product_id)) return $data;
    if (empty($_POST['memesh_round_instance_id'])) return $data; // plain-product / off-date mode
    $data['memesh_round_instance_id'] = sanitize_text_field($_POST['memesh_round_instance_id']);
    $data['memesh_date']              = sanitize_text_field($_POST['memesh_date']);
    $data['memesh_ticket_type']       = memesh_ticket_type_for_product($product_id);
    $data['memesh_extra_companion']   = !empty($_POST['memesh_extra_companion']) ? 1 : 0;
    // The round's hours, for display only (booking truth is the instance id).
    $times = isset($_POST['memesh_round_times']) ? sanitize_text_field($_POST['memesh_round_times']) : '';
    $data['memesh_round_times'] = preg_match('/^[0-9]{2}:[0-9]{2}[–-][0-9]{2}:[0-9]{2}$/u', $times) ? $times : '';
    return $data;
}, 10, 2);

/**
 * The extra companion is charged as a REAL cart line (product 305), because
 * Yanay's cart-page template ignores WC fees, item meta, and name filters —
 * actual line items are the only thing every template renders (Yoav
 * 2026-07-04). The line is auto-managed: it enters with the ticket, leaves
 * with the ticket, and cannot be bought on its own.
 */

// Guard flag so only this snippet can put the companion product in the cart.
function memesh_companion_adding($set = null) {
    static $adding = false;
    if ($set !== null) $adding = $set;
    return $adding;
}

// Block manual purchase of the companion product (direct URL, quick view…).
add_filter('woocommerce_add_to_cart_validation', function ($passed, $product_id) {
    if ((int) $product_id === MEMESH_COMPANION_PRODUCT_ID && !memesh_companion_adding()) {
        wc_add_notice('מלווה נוסף מצטרף דרך כרטיס הכניסה — סמנו את התיבה בעמוד הכרטיס.', 'error');
        return false;
    }
    return $passed;
}, 9, 2);

// An entry ticket added with the companion box ticked pulls the companion
// product in as its own line, linked to the ticket's cart key.
add_action('woocommerce_add_to_cart', function ($cart_item_key, $product_id, $qty, $variation_id, $variation, $cart_item_data) {
    if (!memesh_is_round_product($product_id)) return;
    if (empty($cart_item_data['memesh_extra_companion'])) return;
    memesh_companion_adding(true);
    WC()->cart->add_to_cart(MEMESH_COMPANION_PRODUCT_ID, 1, 0, [], ['memesh_companion_of' => $cart_item_key]);
    memesh_companion_adding(false);
}, 10, 6);

// Keep the pair honest in both directions: removing the ticket removes its
// companion line; removing the companion line stops the ticket from
// reserving (and the API from counting) an extra companion.
add_action('woocommerce_cart_item_removed', function ($removed_key, $cart) {
    foreach ($cart->get_cart() as $key => $item) {
        if (!empty($item['memesh_companion_of']) && $item['memesh_companion_of'] === $removed_key) {
            $cart->remove_cart_item($key);
        }
    }
    $removed = $cart->removed_cart_contents[$removed_key] ?? null;
    if ($removed && !empty($removed['memesh_companion_of'])) {
        $parent_key = $removed['memesh_companion_of'];
        if (isset($cart->cart_contents[$parent_key])) {
            $cart->cart_contents[$parent_key]['memesh_extra_companion'] = 0;
        }
    }
}, 10, 2);

/**
 * Fold the round date + hours into the PRODUCT NAME of the cart item, at the
 * earliest possible moments so EVERY renderer sees it:
 *   - woocommerce_get_cart_item_from_session: cart items are rebuilt fresh
 *     from the DB on every request; renaming here (before anything renders)
 *     is what reaches templates that print the product's own name — the cart
 *     page included. before_calculate_totals was too late for it.
 *   - woocommerce_add_cart_item: covers the request that adds the item.
 *   - woocommerce_cart_item_name filter: covers templates that print via the
 *     filter (mini cart) — guarded so the suffix never doubles.
 * The order line item is created from the renamed product, so emails and
 * invoices inherit "— סבב 05/07/2026 · 09:00–14:00" automatically.
 */
function memesh_apply_round_name($item) {
    $display = memesh_round_display($item);
    if ($display === '' || empty($item['data']) || !is_object($item['data'])) return $item;
    $name = $item['data']->get_name();
    if (mb_strpos($name, ' — סבב ') === false) {
        $item['data']->set_name($name . ' — סבב ' . $display);
    }
    return $item;
}

add_filter('woocommerce_get_cart_item_from_session', function ($item, $values) {
    // Session values carry our keys; the rebuilt item may not have them yet.
    $item = array_merge($values, $item);
    return memesh_apply_round_name($item);
}, 20, 2);

add_filter('woocommerce_add_cart_item', function ($item) {
    return memesh_apply_round_name($item);
}, 20, 1);

add_filter('woocommerce_cart_item_name', function ($name, $cart_item) {
    $display = memesh_round_display($cart_item);
    if ($display !== '' && mb_strpos($name, ' — סבב ') === false) {
        $name .= ' — סבב ' . $display;
    }
    return $name;
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
    // VISIBLE meta (no underscore) — this is what makes the round date + hours
    // appear on the order confirmation email, the WC admin order, and the
    // invoice/receipt, since order documents itemize order-line meta.
    $item->add_meta_data('סבב', memesh_round_display($values), true);
}, 10, 4);
