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
//     tappable rows. A calendar button beside the strip opens a month grid
//     that pages the whole booking window (a year — Yanay 2026-07-05), so
//     customers reach far dates themselves.
//   - [memesh_round_picker product_id="300"] renders the same picker with its
//     own add-to-cart form — made for the price-list page, where each ticket
//     card gets a buy button that opens an Elementor popup with this
//     shortcode. The form posts to the product page, so errors and notices
//     render exactly like a product-page purchase.
//   - Checkout quantity UX (Yanay 2026-07-09..11): the site's OWN "Memesh
//     Checkout" snippet renders the .memesh-qty-controls rows; this snippet
//     does NOT compete with it — it decorates them (memeshDecorateCheckoutRows)
//     so the companion line is frozen and a round-ticket "+" opens the
//     add-ticket picker modal (one seat per line) instead of bumping quantity.
//     A "הוספת כרטיס לילד/ה נוסף/ת" button gives the same modal a guaranteed
//     entry point on cart + checkout.
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

/**
 * One-seat-per-line on the PRODUCT PAGE: a round ticket can't be bought at
 * quantity > 1 (each child is its own line with its own round + hold). The
 * cart/checkout quantity UI is NOT ours — the site's "Memesh Checkout" snippet
 * renders those .memesh-qty-controls rows; this snippet only decorates them
 * from the behavior script (freeze companion, route the ticket "+" to the
 * round picker). See memeshDecorateCheckoutRows() in wp_footer.
 */
add_filter('woocommerce_is_sold_individually', function ($sold, $product) {
    return memesh_is_round_product($product->get_id()) ? true : $sold;
}, 10, 2);

/** Set/read whether any picker rendered on this page — the behavior script
 *  prints once in wp_footer only when at least one did. */
function memesh_picker_script_needed($set = null) {
    static $needed = false;
    if ($set !== null) $needed = $set;
    return $needed;
}

/**
 * The shared picker markup: day strip + calendar button + month grid + the
 * chosen day's rounds + companion card + hidden fields. Used by the product
 * page hook AND the [memesh_round_picker] shortcode so every purchase surface
 * stays identical. No element ids — everything is class-scoped inside the
 * [data-memesh-picker] root, so several pickers coexist on one page (the
 * price list has two).
 */
function memesh_render_round_picker() {
    memesh_picker_script_needed(true);
    ?>
    <div class="memesh-round-picker" data-memesh-picker data-api="<?php echo esc_attr(MEMESH_API_BASE); ?>">
        <div class="memesh-field-label">בחירת יום וסבב</div>
        <div class="memesh-strip-row">
            <button type="button" class="memesh-cal-toggle" style="display:none">
                <span class="memesh-cal-toggle-icon">📅</span>
                <span class="memesh-cal-toggle-label">לוח שנה</span>
            </button>
            <div class="memesh-strip"></div>
        </div>
        <div class="memesh-cal" style="display:none"></div>
        <div class="memesh-rounds"></div>

        <div class="memesh-companion-card">
            <label class="memesh-companion-label">
                <input type="checkbox" name="memesh_extra_companion" value="1" />
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

        <div class="memesh-round-msg">טוען זמינות…</div>
        <div class="memesh-legend" style="display:none">
            <span><i class="memesh-dot memesh-dot-ok"></i> הרבה מקום</span>
            <span><i class="memesh-dot memesh-dot-warn"></i> נשארו מעט</span>
            <span><i class="memesh-dot memesh-dot-full"></i> מלא</span>
            <span><i class="memesh-dot memesh-dot-free"></i> כניסה חופשית</span>
            <span><i class="memesh-dot memesh-dot-closed"></i> סגור</span>
        </div>
        <input type="hidden" name="memesh_date" value="" />
        <input type="hidden" name="memesh_round_instance_id" value="" />
        <input type="hidden" name="memesh_round_times" value="" />
    </div>
    <?php
}

/** Round picker + companion card on the product page. */
add_action('woocommerce_before_add_to_cart_button', function () {
    global $product;
    if (!$product || !memesh_is_round_product($product->get_id())) return;
    if (!memesh_rounds_enabled()) return; // rounds off — plain product
    memesh_render_round_picker();
});

/**
 * [memesh_round_picker product_id="300"] — the product-page picker wrapped in
 * its own add-to-cart form, for the price-list page (Yanay 2026-07-05: buy
 * straight from the price cards). The form posts to the PRODUCT page, so a
 * validation error or the added-to-cart notice renders exactly like a
 * product-page purchase — nothing gets lost on a page without WC templates.
 */
add_shortcode('memesh_round_picker', function ($atts) {
    $atts = shortcode_atts(['product_id' => ''], $atts, 'memesh_round_picker');
    $product_id = (int) $atts['product_id'];
    if (!memesh_is_round_product($product_id)) return '';
    $product = wc_get_product($product_id);
    if (!$product || !$product->is_purchasable()) return '';
    $rounds_on = memesh_rounds_enabled();
    // The footer behavior script must print even when rounds are off (no picker
    // renders): it also wires the AJAX add-to-cart on this form.
    memesh_picker_script_needed(true);

    ob_start();
    ?>
    <form class="cart memesh-shortcode-cart" method="post"
          action="<?php echo esc_url(get_permalink($product_id)); ?>"
          data-memesh-add
          data-add-url="<?php echo esc_url(WC_AJAX::get_endpoint('memesh_add_to_cart')); ?>"
          data-nonce="<?php echo esc_attr(wp_create_nonce('memesh_add_to_cart')); ?>"
          data-checkout-url="<?php echo esc_url(wc_get_checkout_url()); ?>">
        <div class="memesh-shortcode-head">
            <span class="memesh-shortcode-title"><?php echo esc_html($product->get_name()); ?></span>
            <span class="memesh-shortcode-price"><?php echo wp_kses_post($product->get_price_html()); ?></span>
        </div>
        <?php if ($rounds_on) memesh_render_round_picker(); ?>
        <button type="submit" name="add-to-cart" value="<?php echo esc_attr($product_id); ?>"
                class="single_add_to_cart_button memesh-shortcode-buy" <?php echo $rounds_on ? 'disabled' : ''; ?>>
            הוספה לסל
        </button>
        <!-- Shown in place after an AJAX add (Yanay 2026-07-07) — the shopper
             stays in the popup instead of being thrown to the product page. -->
        <div class="memesh-added" style="display:none">
            <div class="memesh-added-title">✓ הכרטיס נוסף לסל</div>
            <div class="memesh-added-round"></div>
            <div class="memesh-added-actions">
                <a class="memesh-added-checkout" href="<?php echo esc_url(wc_get_checkout_url()); ?>">מעבר לתשלום</a>
                <button type="button" class="memesh-added-again">הוספת ילד/ה נוסף/ת</button>
            </div>
        </div>
    </form>
    <?php
    return ob_get_clean();
});

/**
 * AJAX add-to-cart for the price-list popup (Yanay 2026-07-07). The full-page
 * POST used to land shoppers on WordPress's product template — and that page's
 * native button let a second ticket be added with no round chosen (בלי שיבוץ).
 * The popup posts here instead: the SAME WC()->cart->add_to_cart() runs, so every
 * existing hook (validation, add_cart_item_data, the companion auto-add) fires
 * off $_POST exactly as before, and the shopper stays put. Reachable for guests
 * with the cart session loaded — the wc-ajax front controller serves both.
 */
add_action('wc_ajax_memesh_add_to_cart', function () {
    if (!check_ajax_referer('memesh_add_to_cart', 'memesh_nonce', false)) {
        wp_send_json_error(['message' => 'פג תוקף הדף. רעננו את העמוד ונסו שוב.'], 400);
    }
    $product_id = isset($_POST['product_id']) ? (int) $_POST['product_id'] : 0;
    if (!memesh_is_round_product($product_id)) {
        wp_send_json_error(['message' => 'מוצר לא תקין.'], 400);
    }

    // add_to_cart runs woocommerce_add_to_cart_validation + add_cart_item_data,
    // both reading $_POST['memesh_*'] — already on this request from the form.
    $key = WC()->cart->add_to_cart($product_id, 1);
    if (!$key) {
        // The validation hook queued the reason as an error notice; show it in
        // the popup instead of on a page the shopper never reaches.
        $errors = wc_get_notices('error');
        wc_clear_notices();
        $first = $errors[0] ?? null;
        $message = is_array($first) ? ($first['notice'] ?? '') : (is_string($first) ? $first : '');
        $message = $message !== '' ? wp_strip_all_tags($message) : 'לא ניתן להוסיף לסל. בדקו את הבחירה ונסו שוב.';
        error_log('[memesh cart] add_to_cart rejected for product ' . $product_id . ': ' . $message);
        wp_send_json_error(['message' => $message], 200);
    }

    // Drop the queued "added"/upsell notices so they don't surface on the next
    // page load — the popup shows its own confirmation.
    wc_clear_notices();
    $item  = WC()->cart->get_cart_item($key);
    $round = $item ? memesh_round_display($item) : '';
    error_log('[memesh cart] added product ' . $product_id . ' key ' . $key);
    wp_send_json_success([
        'count' => WC()->cart->get_cart_contents_count(),
        'round' => $round,
    ]);
});

/** The first entry-ticket line in the cart — the "add another ticket" button
 *  and the modal's fallback default derive their product + date from it. */
function memesh_first_ticket_line() {
    if (!function_exists('WC') || !WC()->cart) return null;
    foreach (WC()->cart->get_cart() as $item) {
        if (memesh_is_round_product($item['product_id'])) {
            return [
                'product_id' => (int) $item['product_id'],
                'date'       => isset($item['memesh_date']) ? $item['memesh_date'] : '',
            ];
        }
    }
    return null;
}

/**
 * A snippet-OWNED "add another ticket" button for the cart and checkout
 * pages. The per-line "+" only works where the theme renders our quantity
 * markup; the live checkout table draws its own stepper and ignores the
 * filter (Yanay's 2026-07-10 video), so this button — hung on classic WC
 * hooks, not theme markup — is the reliable entry point to the add-ticket
 * modal. It carries the first ticket line's product + date so the picker
 * opens on the right day with a valid product every time.
 */
function memesh_render_add_ticket_button() {
    if (!memesh_rounds_enabled()) return;
    $first = memesh_first_ticket_line();
    if (!$first) return;
    ?>
    <button type="button" class="memesh-add-ticket"
            data-product-id="<?php echo esc_attr($first['product_id']); ?>"
            data-date="<?php echo esc_attr($first['date']); ?>">
        + הוספת כרטיס לילד/ה נוסף/ת
    </button>
    <?php
}
add_action('woocommerce_review_order_before_payment', 'memesh_render_add_ticket_button');
add_action('woocommerce_after_cart_table', 'memesh_render_add_ticket_button');

/**
 * The add-ticket modal for the cart/checkout "+" (Yanay 2026-07-09): a hidden
 * overlay hosting the same picker + AJAX form as the price-list popups, so a
 * ticket added mid-checkout still picks a real date and round — never a bare
 * quantity bump. The opener passes the clicked line's product and date; the
 * picker preselects that date (data-default-date / memeshSelectDate in the
 * behavior script), per Yanay: the original ticket's date is the default. The
 * data-default-* attributes are the server-rendered fallback — if any opener
 * arrives without its own product/date, the first ticket line's values apply
 * instead of an empty submit (Yanay's 2026-07-10 video: the modal opened on
 * a closed "today" with no product attached). Rendered only where it can be
 * used: cart/checkout, rounds on, and at least one ticket line to add to.
 */
add_action('wp_footer', function () {
    if (!function_exists('is_cart') || (!is_cart() && !is_checkout())) return;
    if (!memesh_rounds_enabled() || !WC()->cart) return;
    $first = memesh_first_ticket_line();
    if (!$first) return;
    memesh_picker_script_needed(true);
    // Cart-key → line map for the behavior script: the theme's item rows are
    // identified by their remove link (?remove_item=<key>), and this map says
    // which key is a ticket (t:1) vs a companion (t:0), with the ticket's
    // product + date for the modal. Keys are WC cart-id hashes — no PII.
    $lines = [];
    foreach (WC()->cart->get_cart() as $key => $item) {
        $pid = (int) $item['product_id'];
        if (memesh_is_round_product($pid)) {
            $lines[$key] = [
                'p' => $pid,
                'd' => isset($item['memesh_date']) ? $item['memesh_date'] : '',
                't' => 1,
            ];
        } elseif ($pid === MEMESH_COMPANION_PRODUCT_ID) {
            $lines[$key] = ['p' => $pid, 'd' => '', 't' => 0];
        }
    }
    ?>
    <script>window.memeshCartLines = <?php echo wp_json_encode($lines); ?>;</script>
    <div class="memesh-modal" data-memesh-add-modal style="display:none"
         data-fallback-product-id="<?php echo esc_attr($first['product_id']); ?>"
         data-fallback-date="<?php echo esc_attr($first['date']); ?>">
        <div class="memesh-modal-backdrop" data-memesh-modal-close></div>
        <div class="memesh-modal-card">
            <button type="button" class="memesh-modal-close" data-memesh-modal-close
                    aria-label="סגירה">×</button>
            <form class="cart memesh-shortcode-cart" method="post" action=""
                  data-memesh-add data-reload-on-add="1"
                  data-add-url="<?php echo esc_url(WC_AJAX::get_endpoint('memesh_add_to_cart')); ?>"
                  data-nonce="<?php echo esc_attr(wp_create_nonce('memesh_add_to_cart')); ?>">
                <div class="memesh-shortcode-head">
                    <span class="memesh-shortcode-title">הוספת כרטיס נוסף</span>
                </div>
                <?php memesh_render_round_picker(); ?>
                <button type="submit" name="add-to-cart" value=""
                        class="single_add_to_cart_button memesh-shortcode-buy" disabled>
                    הוספה לסל
                </button>
            </form>
        </div>
    </div>
    <?php
}, 10);

/** Picker behavior — printed once per page, initializes every picker root. */
add_action('wp_footer', function () {
    if (!memesh_picker_script_needed()) return;
    ?>
    <script>
    // Day-strip + month-calendar picker (Yanay 2026-07-05): one
    // availability-range call renders a month of day chips with status dots;
    // the calendar button opens a month grid that pages the rest of the
    // booking window (up to the API's maxDate), one fetch per month, cached.
    // Tapping a day lists its rounds; tapping a row fills the hidden fields
    // the checkout hold reads. All DOM is built with createElement — nothing
    // from the API is ever concatenated into HTML. Lookups are class-scoped
    // inside each [data-memesh-picker] root so several pickers share a page.
    (function () {
        var HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                         'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
        var DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

        function ymOf(iso) { return iso.slice(0, 7); }
        function daysInMonth(ym) {
            return new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
        }
        function addMonths(ym, delta) {
            var total = Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1) + delta;
            var m = (total % 12) + 1;
            return Math.floor(total / 12) + '-' + (m < 10 ? '0' + m : String(m));
        }
        function monthLabel(ym) {
            return HE_MONTHS[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
        }

        function initPicker(root) {
            var api = root.getAttribute('data-api');
            var form = root.closest ? root.closest('form.cart') : null;
            var stripEl = root.querySelector('.memesh-strip');
            var roundsEl = root.querySelector('.memesh-rounds');
            var msgEl = root.querySelector('.memesh-round-msg');
            var legendEl = root.querySelector('.memesh-legend');
            var calToggle = root.querySelector('.memesh-cal-toggle');
            var calEl = root.querySelector('.memesh-cal');
            var dateEl = root.querySelector('input[name="memesh_date"]');
            var roundEl = root.querySelector('input[name="memesh_round_instance_id"]');
            var timesEl = root.querySelector('input[name="memesh_round_times"]');
            if (!stripEl || !dateEl) return;
            console.info('[memesh picker] initPicker', { api: api, inForm: !!form });

            var dayCache = {};       // date → day, every fetch lands here
            var todayIso = null;     // venue today = first day of the initial fetch
            var maxDate = null;      // end of the booking window (API maxDate)
            var selectedDate = null;
            var calMonth = null;
            var calLoading = false;

            // The add-to-cart button stays disabled until the selection is
            // valid — not-clickable beats a reload-with-error.
            function cartBtn() {
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
                if (day.closed) return 'memesh-dot-closed';
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
                // The round's hours ride along so the cart / checkout / receipt
                // can show "סבב 05/07/2026 · 09:00–14:00", not just the date.
                timesEl.value = times;
                setMsg('');
                setCanBuy(true);
            }

            function roundRow(x, optional) {
                var row = document.createElement('button');
                row.type = 'button'; // inside form.cart — default type would submit
                row.className = 'memesh-round-row';

                var info = document.createElement('span');
                info.className = 'memesh-round-info';
                var label = document.createElement('span');
                label.className = 'memesh-round-label';
                label.textContent = x.label;
                info.appendChild(label);
                // Admins often embed the hours in the round name ("בוקר 9:00 - 14:00");
                // add our own hours line only when the name doesn't carry them, so
                // they never print twice.
                if (!/\d{1,2}:\d{2}/.test(x.label)) {
                    var time = document.createElement('span');
                    time.className = 'memesh-round-time';
                    time.textContent = x.startTime + '–' + x.endTime;
                    info.appendChild(time);
                }

                var scarce = x.capacity > 0 && x.available / x.capacity <= 0.25;
                var state = document.createElement('span');
                state.className = 'memesh-round-state';
                var pill = document.createElement('span');
                pill.className = 'memesh-round-pill' + (scarce ? ' is-scarce' : '');
                pill.textContent = x.available + ' פנויים';
                var bar = document.createElement('span');
                bar.className = 'memesh-round-bar';
                var fill = document.createElement('span');
                fill.className = 'memesh-round-bar-fill' + (scarce ? ' is-scarce' : '');
                fill.style.width = (x.capacity > 0 ? Math.max(6, Math.round((x.available / x.capacity) * 100)) : 0) + '%';
                bar.appendChild(fill);
                state.appendChild(pill);
                state.appendChild(bar);

                row.appendChild(info);
                row.appendChild(state);
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

                if (day.closed) {
                    setMsg('המקום סגור בתאריך זה — בחרו יום אחר.');
                    setCanBuy(false);
                    return;
                }

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
                // A single mandatory round selects itself — a lone option that
                // still demands a tap left the button disabled and read as
                // "לא נותן להוסיף" (Yanay's 2026-07-10 video). With a real
                // choice (2+ rounds, or optional free play) the tap stays.
                if (!optional && open.length === 1) {
                    var only = roundsEl.querySelector('.memesh-round-row');
                    if (only) only.click();
                }
            }

            // Single entry point for picking a day (strip chip OR calendar
            // cell) so highlight + rounds + calendar always agree.
            function setSelectedDate(dateIso) {
                selectedDate = dateIso;
                var chips = stripEl.querySelectorAll('.memesh-day-chip');
                for (var i = 0; i < chips.length; i += 1) {
                    chips[i].classList.toggle('is-active', chips[i].getAttribute('data-date') === dateIso);
                }
                var day = dayCache[dateIso];
                if (day) renderDay(day);
                if (calEl.style.display !== 'none') renderCalendar();
            }

            function dayChip(day, index) {
                var chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'memesh-day-chip';
                chip.setAttribute('data-date', day.date);
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
                chip.addEventListener('click', function () { setSelectedDate(day.date); });
                return chip;
            }

            // ---- month calendar (Yanay 2026-07-05: next month, next year) ----
            function navBtn(glyph, enabled, delta) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'memesh-cal-nav';
                b.textContent = glyph;
                b.disabled = !enabled;
                if (enabled) b.addEventListener('click', function () { setCalMonth(addMonths(calMonth, delta)); });
                return b;
            }

            function calCell(iso, num) {
                var day = dayCache[iso];
                var inWindow = !!todayIso && iso >= todayIso && !!maxDate && iso <= maxDate && !!day;
                var cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'memesh-cal-cell' + (selectedDate === iso ? ' is-active' : '');
                cell.disabled = !inWindow;
                var n = document.createElement('span');
                n.className = 'memesh-cal-num';
                n.textContent = String(num);
                var dot = document.createElement('i');
                dot.className = 'memesh-dot ' + (inWindow ? dayDotClass(day) : 'memesh-dot-blank');
                cell.appendChild(n);
                cell.appendChild(dot);
                if (inWindow) {
                    cell.addEventListener('click', function () {
                        setSelectedDate(iso);
                        toggleCal(false);
                    });
                }
                return cell;
            }

            function renderCalendar() {
                calEl.textContent = '';
                var head = document.createElement('div');
                head.className = 'memesh-cal-head';
                // RTL: the past sits to the right, so the right-hand button walks back.
                head.appendChild(navBtn('›', !!todayIso && calMonth > ymOf(todayIso), -1));
                var title = document.createElement('span');
                title.className = 'memesh-cal-title';
                title.textContent = monthLabel(calMonth);
                head.appendChild(title);
                head.appendChild(navBtn('‹', !!maxDate && calMonth < ymOf(maxDate), 1));
                calEl.appendChild(head);

                var grid = document.createElement('div');
                grid.className = 'memesh-cal-grid';
                DOW.forEach(function (l) {
                    var c = document.createElement('span');
                    c.className = 'memesh-cal-dow';
                    c.textContent = l + '׳';
                    grid.appendChild(c);
                });
                var blanks = new Date(calMonth + '-01T12:00:00').getDay();
                for (var b = 0; b < blanks; b += 1) grid.appendChild(document.createElement('span'));
                var count = daysInMonth(calMonth);
                for (var d = 1; d <= count; d += 1) {
                    grid.appendChild(calCell(calMonth + '-' + (d < 10 ? '0' + d : String(d)), d));
                }
                calEl.appendChild(grid);

                if (calLoading) {
                    var loading = document.createElement('div');
                    loading.className = 'memesh-cal-loading';
                    loading.textContent = 'טוען חודש…';
                    calEl.appendChild(loading);
                }
            }

            // One fetch per month, remembered for the life of the page.
            function setCalMonth(ym) {
                calMonth = ym;
                var count = daysInMonth(ym);
                var missing = false;
                for (var d = 1; d <= count; d += 1) {
                    if (!dayCache[ym + '-' + (d < 10 ? '0' + d : String(d))]) { missing = true; break; }
                }
                if (!missing) { renderCalendar(); return; }
                calLoading = true;
                renderCalendar();
                fetch(api + '/rounds/availability-range?days=' + count + '&from=' + ym + '-01')
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        (data.days || []).forEach(function (day) { dayCache[day.date] = day; });
                        calLoading = false;
                        if (calMonth === ym) renderCalendar();
                    })
                    .catch(function () {
                        calLoading = false;
                        if (calMonth === ym) renderCalendar();
                    });
            }

            function toggleCal(show) {
                var open = show === undefined ? calEl.style.display === 'none' : show;
                calEl.style.display = open ? '' : 'none';
                calToggle.classList.toggle('is-active', open);
                if (open) setCalMonth(calMonth || ymOf(selectedDate || todayIso));
            }

            if (calToggle) {
                calToggle.addEventListener('click', function () {
                    if (todayIso) toggleCal();
                });
            }

            // Jump to a specific date from outside the picker — the cart/
            // checkout "+" passes its line's date so the new ticket defaults
            // to the same day (Yanay 2026-07-09). Out-of-window dates are
            // ignored (today stays selected); a date beyond the strip's 31
            // days loads its month first, exactly like the calendar does.
            root.memeshSelectDate = function (iso) {
                if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
                if (!todayIso) { root.setAttribute('data-default-date', iso); return; }
                if (iso < todayIso || (maxDate && iso > maxDate)) return;
                if (dayCache[iso]) { setSelectedDate(iso); return; }
                console.info('[memesh picker] default date beyond strip — loading its month', { date: iso });
                fetch(api + '/rounds/availability-range?days=' + daysInMonth(ymOf(iso)) + '&from=' + ymOf(iso) + '-01')
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        (data.days || []).forEach(function (day) { dayCache[day.date] = day; });
                        if (dayCache[iso]) setSelectedDate(iso);
                    })
                    .catch(function (err) {
                        console.warn('[memesh picker] default-date month fetch failed', err);
                    });
            };

            setCanBuy(false); // nothing valid until the strip loads and a day is picked
            // 31 days feed the strip; the calendar pages the rest of the window.
            console.info('[memesh picker] loading availability strip', { api: api });
            fetch(api + '/rounds/availability-range?days=31')
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (data) {
                    var days = data.days || [];
                    console.info('[memesh picker] strip loaded', {
                        days: days.length, maxDate: data.maxDate || null,
                    });
                    if (days.length === 0) {
                        setMsg('אין סבבים פנויים כרגע. נסו שוב מאוחר יותר.');
                        return;
                    }
                    todayIso = days[0].date;
                    // Older API without maxDate → calendar limited to the strip's reach.
                    maxDate = data.maxDate || days[days.length - 1].date;
                    days.forEach(function (day, index) {
                        dayCache[day.date] = day;
                        stripEl.appendChild(dayChip(day, index));
                    });
                    legendEl.style.display = '';
                    if (calToggle) calToggle.style.display = '';
                    setSelectedDate(days[0].date); // today preselected, its rounds visible
                    // A default date queued before the strip loaded (the modal
                    // opened early) applies now, replacing the today default.
                    var preset = root.getAttribute('data-default-date');
                    if (preset) {
                        root.removeAttribute('data-default-date');
                        root.memeshSelectDate(preset);
                    }
                })
                .catch(function (err) {
                    console.warn('[memesh picker] strip fetch failed', err);
                    setMsg('לא ניתן לטעון סבבים כרגע. רעננו את העמוד ונסו שוב.');
                });
        }

        // AJAX add-to-cart for the price-list popup form (Yanay 2026-07-07):
        // submit adds the ticket in place and swaps the picker for an in-popup
        // confirmation, so the shopper is never thrown to the WordPress product
        // page. The form keeps its product-page `action` as a no-JS fallback.
        function wireCartForm(form) {
            var addUrl = form.getAttribute('data-add-url');
            var nonce = form.getAttribute('data-nonce');
            var btn = form.querySelector('.single_add_to_cart_button');
            var added = form.querySelector('.memesh-added');
            var addedRound = added && added.querySelector('.memesh-added-round');
            var againBtn = added && added.querySelector('.memesh-added-again');
            var picker = form.querySelector('[data-memesh-picker]');
            var msgEl = form.querySelector('.memesh-round-msg');
            if (!addUrl || !btn) return;

            function showError(text) {
                if (msgEl) { msgEl.textContent = text; msgEl.style.color = '#a23a3a'; }
            }

            form.addEventListener('submit', function (e) {
                e.preventDefault();
                var productId = btn.value;
                var fd = new FormData(form); // carries the memesh_* hidden inputs + companion box
                fd.append('product_id', productId);
                fd.append('memesh_nonce', nonce);
                var label = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'מוסיף…';
                console.info('[memesh cart] ajax add', { productId: productId });
                fetch(addUrl, { method: 'POST', body: fd, credentials: 'same-origin' })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        btn.textContent = label;
                        if (res && res.success) {
                            console.info('[memesh cart] added', res.data);
                            if (form.hasAttribute('data-reload-on-add')) {
                                // Cart/checkout modal: the reloaded page IS the
                                // confirmation — the new line and the updated
                                // total render server-side, no stale fragments.
                                console.info('[memesh qty] added from modal — reloading page');
                                window.location.reload();
                                return;
                            }
                            if (addedRound) addedRound.textContent =
                                res.data && res.data.round ? 'סבב ' + res.data.round : '';
                            if (picker) picker.style.display = 'none';
                            btn.style.display = 'none';
                            if (added) added.style.display = 'flex';
                            // Let the theme's mini-cart refresh its count/fragments.
                            if (window.jQuery) window.jQuery(document.body).trigger('wc_fragment_refresh');
                        } else {
                            var m = (res && res.data && res.data.message) || 'לא ניתן להוסיף לסל. נסו שוב.';
                            console.warn('[memesh cart] add rejected', m);
                            showError(m);
                            btn.disabled = false;
                        }
                    })
                    .catch(function (err) {
                        console.warn('[memesh cart] add failed', err);
                        btn.textContent = label;
                        btn.disabled = false;
                        showError('לא ניתן להוסיף לסל כרגע. נסו שוב.');
                    });
            });

            // "Add another child": restore the picker + button. The last valid
            // selection stays put, so twins on the same round go through with one
            // more tap; changing the day re-runs the picker's own gating.
            if (againBtn) {
                againBtn.addEventListener('click', function () {
                    if (added) added.style.display = 'none';
                    btn.style.display = '';
                    btn.disabled = false;
                    if (picker) picker.style.display = '';
                });
            }
        }

        // Cart/checkout "+" → the add-ticket modal (Yanay 2026-07-09). One
        // modal serves every ticket line: the click stamps the line's product
        // on the submit button and preselects the line's date in the picker,
        // so "another ticket" always means "another date-and-round choice".
        // Capture phase, so a theme's own stepper handler never sees the click.
        function openAddModal(productId, dateIso) {
            var modal = document.querySelector('[data-memesh-add-modal]');
            if (!modal) return;
            // Openers without their own line data (or a stray trigger — seen
            // in Yanay's 2026-07-10 video) fall back to the first ticket
            // line's product + date, server-rendered on the modal root, so
            // the picker never opens dateless with an unset product.
            productId = productId || modal.getAttribute('data-fallback-product-id');
            dateIso = dateIso || modal.getAttribute('data-fallback-date');
            var btn = modal.querySelector('.single_add_to_cart_button');
            if (btn) btn.value = productId || '';
            modal.style.display = '';
            document.body.classList.add('memesh-modal-open');
            console.info('[memesh qty] add-ticket modal opened', {
                productId: productId, defaultDate: dateIso || null,
            });
            var root = modal.querySelector('[data-memesh-picker]');
            if (root && dateIso) {
                if (root.memeshSelectDate) root.memeshSelectDate(dateIso);
                else root.setAttribute('data-default-date', dateIso);
            }
        }
        function closeAddModal() {
            var modal = document.querySelector('[data-memesh-add-modal]');
            if (!modal || modal.style.display === 'none') return;
            modal.style.display = 'none';
            document.body.classList.remove('memesh-modal-open');
            console.info('[memesh qty] add-ticket modal closed');
        }
        // Capture phase so we preempt the site checkout widget's OWN delegated
        // (bubble-phase) click handler on .memesh-qty-btn — stopPropagation here
        // stops the event before it ever reaches theirs.
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || !t.closest) return;

            // The snippet-owned dashed "add another child" button.
            var dashed = t.closest('.memesh-add-ticket');
            if (dashed) {
                e.preventDefault();
                e.stopPropagation();
                openAddModal(dashed.getAttribute('data-product-id'), dashed.getAttribute('data-date'));
                return;
            }

            if (t.closest('[data-memesh-modal-close]')) { closeAddModal(); return; }

            // The site checkout widget's own buttons. We decide per line via the
            // memeshCartLines map (read live, so a row not yet class-decorated
            // still behaves right): companion → swallow every click (frozen);
            // round-ticket "+" → open the picker instead of bumping quantity.
            // Ticket "−"/"×", punch cards and other products fall through to the
            // site widget untouched.
            var siteBtn = t.closest('.memesh-qty-controls .memesh-qty-btn, .memesh-qty-controls .memesh-qty-remove');
            if (siteBtn) {
                var ctrl = siteBtn.closest('.memesh-qty-controls');
                var lines = window.memeshCartLines || {};
                var line = lines[ctrl.getAttribute('data-cart-key')];
                if (line && line.t === 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                if (line && line.t === 1 && siteBtn.getAttribute('data-action') === 'plus') {
                    e.preventDefault();
                    e.stopPropagation();
                    openAddModal(line.p, line.d || '');
                    return;
                }
            }
        }, true);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeAddModal();
        });

        // Cooperate with the site's OWN checkout quantity widget (the "Memesh
        // Checkout" snippet renders .memesh-qty-controls[data-cart-key] with
        // .memesh-qty-btn/.memesh-qty-remove buttons and its own AJAX qty
        // updater). We do NOT render competing controls — we only DECORATE its
        // rows, keyed by data-cart-key against the server-printed
        // memeshCartLines map, so it stays the single owner of that UI:
        //   • companion line (t=0, or the widget's own data-is-companion) →
        //     frozen: the whole controls block is hidden (auto-managed with
        //     the ticket; never changed by hand).
        //   • round-ticket line (t=1) → the −/input are hidden (one seat per
        //     line) and only the "+" and "×" remain; the "+" is force-enabled
        //     (our sold_individually made the widget render it disabled) and
        //     the click handler routes it to the add-ticket picker.
        //   • punch cards / other products → not in the map, left fully native.
        //
        // Hiding/enabling is done with INLINE styles, not a stylesheet: the
        // classes-only approach failed live because LiteSpeed served a stale
        // combined CSS bundle without our rules (Yanay 2026-07-11 — the classes
        // were on the elements, but the CSS never hid them). Inline styles set
        // at runtime can't be cache-stripped and beat the widget's own CSS.
        // Correctness also lives in the capture-phase click handler above,
        // which reads the map directly regardless of decoration timing.
        function memeshDecorateCheckoutRows() {
            var lines = window.memeshCartLines || {};
            var blocks = document.querySelectorAll('.memesh-qty-controls[data-cart-key]');
            for (var i = 0; i < blocks.length; i += 1) {
                var ctrl = blocks[i];
                var line = lines[ctrl.getAttribute('data-cart-key')];
                var isCompanion = (line && line.t === 0) || ctrl.getAttribute('data-is-companion') === '1';
                if (isCompanion) {
                    if (ctrl.style.display !== 'none') {
                        ctrl.style.display = 'none';
                        console.info('[memesh qty] companion row frozen (hidden)');
                    }
                    continue;
                }
                if (line && line.t === 1) {
                    var minus = ctrl.querySelector('.memesh-qty-minus');
                    var input = ctrl.querySelector('.memesh-qty-input');
                    var plus  = ctrl.querySelector('.memesh-qty-plus');
                    if (minus) minus.style.display = 'none';
                    if (input) input.style.display = 'none';
                    if (plus) {
                        // Force the "+" back to clickable — WE own it now (it
                        // opens the picker, never bumps qty), so the widget's
                        // max=1 disabling is irrelevant.
                        plus.removeAttribute('disabled');
                        plus.classList.remove('memesh-qty-disabled');
                        plus.style.display = '';
                        plus.style.opacity = '1';
                        plus.style.pointerEvents = 'auto';
                        plus.style.cursor = 'pointer';
                    }
                    if (!ctrl.classList.contains('memesh-ticket-row')) {
                        ctrl.classList.add('memesh-ticket-row');
                        console.info('[memesh qty] ticket row: "+" routed to the picker', {
                            productId: line.p, date: line.d || null,
                        });
                    }
                }
            }
        }

        // Track initialized roots in a WeakSet, not a DOM attribute: Elementor
        // opens a popup by CLONING its content into a fresh visible node, and a
        // DOM-attribute guard clones along with it — so we would skip the very
        // node the customer sees and leave "טוען זמינות…" frozen. A WeakSet keys
        // on object identity, so a clone is correctly seen as uninitialized.
        var initedRoots = new WeakSet();
        var wiredForms = new WeakSet();
        function initAll() {
            var roots = document.querySelectorAll('[data-memesh-picker]');
            var fresh = 0;
            for (var i = 0; i < roots.length; i += 1) {
                var root = roots[i];
                if (initedRoots.has(root)) continue;
                // Defer until the popup subtree is fully injected: Elementor may
                // add the root a beat before its fields. The observer fires again
                // when they land, so skipping now (without marking) is safe.
                if (!root.querySelector('.memesh-strip') ||
                    !root.querySelector('input[name="memesh_date"]')) continue;
                initedRoots.add(root);
                fresh += 1;
                initPicker(root);
            }
            // Wire every price-list popup form once (Elementor clones get their
            // own identity, so a cloned popup re-wires correctly).
            var forms = document.querySelectorAll('form[data-memesh-add]');
            for (var j = 0; j < forms.length; j += 1) {
                if (wiredForms.has(forms[j])) continue;
                wiredForms.add(forms[j]);
                wireCartForm(forms[j]);
            }
            memeshDecorateCheckoutRows();
            if (fresh > 0) {
                console.info('[memesh picker] init', { onPage: roots.length, newlyInitialized: fresh });
            }
        }

        // The site checkout widget re-renders its rows on every updated_checkout
        // (billing edits, coupons…) and on fragment refreshes, so re-decorate
        // then too — the MutationObserver usually catches it, this is the belt.
        if (window.jQuery) {
            window.jQuery(document.body).on(
                'updated_checkout wc_fragments_refreshed wc_fragments_loaded',
                memeshDecorateCheckoutRows,
            );
        }

        // The picker usually lives inside an Elementor popup, whose markup is
        // injected (or cloned) into the DOM only when the popup opens — well
        // after DOMContentLoaded, the one moment the old code scanned. A
        // MutationObserver re-runs init whenever nodes are added, so the picker
        // comes alive the instant the popup appears. Debounced to one pass per
        // frame so a busy WP page never thrashes.
        var scheduleQueued = false;
        var raf = window.requestAnimationFrame
            ? window.requestAnimationFrame.bind(window)
            : function (cb) { return setTimeout(cb, 16); };
        function scheduleInit() {
            if (scheduleQueued) return;
            scheduleQueued = true;
            raf(function () { scheduleQueued = false; initAll(); });
        }
        if (typeof MutationObserver !== 'undefined') {
            new MutationObserver(scheduleInit).observe(document.documentElement, {
                childList: true, subtree: true,
            });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
        else initAll();
    })();
    </script>
    <?php
}, 50);

/** Styling for the picker, the calendar, the companion card, the shortcode
 *  form, and the upsell notice. */
add_action('wp_head', function () {
    ?>
    <style>
    .memesh-round-picker { direction: rtl; margin: 18px 0; display: flex; flex-direction: column; gap: 12px; }
    .memesh-field-label { font-size: 14px; font-weight: 500; color: #333; }
    .memesh-round-msg { font-size: 13px; color: #a23a3a; min-height: 16px; }

    /* Day strip — same look as the customer dashboard picker. The chip, row,
       and calendar buttons reset theme button styling hard: WP themes love to
       paint every <button>. */
    .memesh-strip-row { display: flex; gap: 6px; align-items: stretch; }
    .memesh-strip {
        display: flex; gap: 6px; overflow-x: auto; padding: 2px 2px 4px;
        flex: 1; min-width: 0;
        -webkit-overflow-scrolling: touch;
    }
    .memesh-strip .memesh-day-chip,
    .memesh-rounds .memesh-round-row,
    .memesh-cal-toggle,
    .memesh-cal-nav,
    .memesh-cal-cell {
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
    .memesh-dot-closed { background: #8a7f76; }
    .memesh-dot-none { background: #d9d2c9; }
    .memesh-dot-blank { background: transparent; }
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
    .memesh-round-info { display: flex; flex-direction: column; gap: 2px; text-align: right; }
    .memesh-round-label { font-weight: 600; color: #2d3436; }
    .memesh-round-time { color: #636e72; font-size: 12.5px; }
    .memesh-round-state { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .memesh-round-pill {
        font-size: 12px; font-weight: 700; border-radius: 999px; padding: 3px 9px;
        white-space: nowrap; background: #eef4e2; color: #5b7a34;
    }
    .memesh-round-pill.is-scarce { background: #fdf3e3; color: #b9772a; }
    .memesh-round-bar {
        width: 64px; height: 5px; border-radius: 999px; background: #f0ebe4;
        overflow: hidden; display: block;
    }
    .memesh-round-bar-fill {
        display: block; height: 100%; border-radius: 999px; background: #8fae5d;
    }
    .memesh-round-bar-fill.is-scarce { background: #e7a33e; }

    /* Paid-companion opt-in — a bordered card matching the day/round cards, with
       the checkbox at the inline-start (right, in RTL) and the +₪12 price pinned
       to the far inline-end of the header row. */
    .memesh-companion-card {
        border: 1.5px solid #e9e0d9; border-radius: 12px; background: #fff;
        padding: 12px 14px;
    }
    .memesh-companion-label {
        display: flex; align-items: flex-start; gap: 10px; margin: 0; cursor: pointer;
    }
    .memesh-companion-label input[type="checkbox"] {
        flex: 0 0 auto; width: 18px; height: 18px; margin: 2px 0 0;
        accent-color: #b9772a; cursor: pointer;
    }
    .memesh-companion-content {
        flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px;
    }
    .memesh-companion-header {
        display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    }
    .memesh-companion-header strong { font-size: 14px; font-weight: 700; color: #2d3436; }
    .memesh-companion-price { font-size: 13px; font-weight: 700; color: #b9772a; white-space: nowrap; }
    .memesh-companion-note { font-size: 12px; color: #636e72; line-height: 1.5; }

    /* Calendar button + month grid (Yanay 2026-07-05). */
    .memesh-cal-toggle {
        flex: 0 0 auto; min-width: 52px; padding: 8px 6px;
        border: 1.5px solid #e9e0d9; background: #fff; border-radius: 12px;
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 4px;
    }
    .memesh-cal-toggle.is-active { border-color: #e7a33e; background: #fdf3e3; }
    .memesh-cal-toggle-icon { font-size: 17px; line-height: 1; }
    .memesh-cal-toggle-label { font-size: 9.5px; color: #636e72; font-weight: 600; }
    .memesh-cal {
        border: 1.5px solid #e9e0d9; border-radius: 12px; padding: 12px;
        display: flex; flex-direction: column; gap: 10px; background: #fff;
    }
    .memesh-cal-head { display: flex; align-items: center; justify-content: space-between; }
    .memesh-cal-title { font-size: 14.5px; font-weight: 700; color: #2d3436; }
    .memesh-cal-nav {
        width: 34px; height: 34px; border: 1.5px solid #e9e0d9; background: #fff;
        border-radius: 10px; font-size: 18px; color: #2d3436;
        display: inline-flex; align-items: center; justify-content: center;
    }
    .memesh-cal-nav:disabled { color: #d9d2c9; cursor: default; }
    .memesh-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
    .memesh-cal-dow { text-align: center; font-size: 10.5px; color: #636e72; font-weight: 600; }
    .memesh-cal-cell {
        border: 1.5px solid transparent; background: transparent; border-radius: 9px;
        padding: 5px 0 4px; display: flex; flex-direction: column;
        align-items: center; gap: 3px;
    }
    .memesh-cal-cell.is-active { border-color: #e7a33e; background: #fdf3e3; }
    .memesh-cal-cell:disabled { cursor: default; }
    .memesh-cal-num { font-size: 13.5px; font-weight: 500; color: #2d3436; }
    .memesh-cal-cell.is-active .memesh-cal-num { color: #b9772a; font-weight: 700; }
    .memesh-cal-cell:disabled .memesh-cal-num { color: #d9d2c9; }
    .memesh-cal-loading { text-align: center; color: #636e72; font-size: 12.5px; }

    /* The shortcode's own add-to-cart form (price-list popups). */
    .memesh-shortcode-cart { direction: rtl; display: flex; flex-direction: column; gap: 12px; margin: 0; }
    /* Reserve inline-end room (the left edge in RTL) so the price never slides
       under the Elementor popup close button, which sits in that corner. */
    .memesh-shortcode-head {
        display: flex; justify-content: space-between; align-items: baseline;
        gap: 8px; padding-inline-end: 44px;
    }
    .memesh-shortcode-title { font-size: 17px; font-weight: 700; color: #2d3436; }
    .memesh-shortcode-price { font-size: 16px; font-weight: 600; color: #a25a1c; white-space: nowrap; }
    .memesh-shortcode-buy {
        border: none; background: #b18a5a; color: #fff; border-radius: 8px;
        padding: 12px 18px; font-size: 15px; font-weight: 600; cursor: pointer;
    }
    .memesh-shortcode-buy:hover { background: #9a7449; }
    .memesh-shortcode-buy:disabled { opacity: 0.5; cursor: default; }

    /* In-popup confirmation after an AJAX add (Yanay 2026-07-07). */
    .memesh-added { direction: rtl; flex-direction: column; gap: 10px; text-align: center; padding: 6px 0; }
    .memesh-added-title { font-size: 16px; font-weight: 700; color: #5b7a34; }
    .memesh-added-round { font-size: 13px; color: #636e72; min-height: 16px; }
    .memesh-added-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .memesh-added-checkout {
        display: block; background: #b18a5a; color: #fff !important; border-radius: 8px;
        padding: 12px 18px; font-size: 15px; font-weight: 600; text-decoration: none;
    }
    .memesh-added-checkout:hover { background: #9a7449; }
    .memesh-added-again {
        appearance: none; -webkit-appearance: none; font-family: inherit; cursor: pointer;
        background: #fff; color: #b9772a; border: 1.5px solid #e9e0d9; border-radius: 8px;
        padding: 11px 18px; font-size: 14px; font-weight: 600;
    }
    .memesh-added-again:hover { background: #fdf3e3; }

    /* Note: freezing the companion row and trimming the ticket row to "+"/"×"
       is done with INLINE styles in memeshDecorateCheckoutRows(), not here —
       an embedded stylesheet got cache-stripped by LiteSpeed on the live site
       (Yanay 2026-07-11). Keep the visual contract in the JS so it can't drift
       from a stale CSS bundle. */

    /* The snippet-owned "add another ticket" button (cart + checkout). */
    .memesh-add-ticket {
        appearance: none; -webkit-appearance: none; box-shadow: none; margin: 12px 0;
        font-family: inherit; cursor: pointer; direction: rtl;
        display: block; width: 100%; padding: 12px 16px;
        border: 1.5px dashed #b18a5a; border-radius: 10px;
        background: #fdf8f0; color: #8a5a12;
        font-size: 14.5px; font-weight: 600; text-align: center;
    }
    .memesh-add-ticket:hover { background: #fdf3e3; }

    /* The add-ticket modal opened by the cart/checkout "+". */
    .memesh-modal {
        position: fixed; inset: 0; z-index: 100000;
        display: flex; align-items: center; justify-content: center; padding: 16px;
    }
    .memesh-modal-backdrop { position: absolute; inset: 0; background: rgba(45, 52, 54, 0.5); }
    .memesh-modal-card {
        position: relative; background: #fff; border-radius: 16px; direction: rtl;
        width: 100%; max-width: 430px; max-height: calc(100vh - 32px);
        overflow-y: auto; padding: 20px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
    }
    .memesh-modal-close {
        appearance: none; -webkit-appearance: none; box-shadow: none; margin: 0;
        font-family: inherit; cursor: pointer; position: absolute; top: 10px; left: 10px;
        width: 32px; height: 32px; border: none; border-radius: 50%;
        background: #f5f1ec; color: #636e72; font-size: 19px; line-height: 1;
        display: inline-flex; align-items: center; justify-content: center; padding: 0;
    }
    .memesh-modal-close:hover { background: #ece5dd; color: #2d3436; }
    body.memesh-modal-open { overflow: hidden; }

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
        // A second entry ticket is allowed (Yanay 2026-07-07 — book several
        // children in one order, each its own line via memesh_uid). We keep the
        // punch-card note as an informational upsell but no longer BLOCK the
        // add, so two same-age kids on the same or different dates go through.
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
    // One child per line: a unique token per add gives every pick its own cart
    // line, so WooCommerce never merges two children into quantity 2 (Yanay
    // 2026-07-07 — several children, possibly different dates, in one order).
    // It is also the oversell guard: one line means exactly one held seat at
    // checkout. Stamped on every entry ticket, including free-play/off-date
    // ones (which return early below), so two free-day kids also split cleanly.
    $data['memesh_uid'] = wp_generate_uuid4();
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

// After a child is added the shopper returns to the product page, so a short
// note makes the "add another child" option obvious (Yanay 2026-07-07). Only
// on the FIRST entry ticket — from the second on, the punch-card upsell already
// signals more can be added, so we stay quiet and avoid stacking notices. Fires
// only for entry tickets, so the auto-added companion line never triggers it.
add_action('woocommerce_add_to_cart', function ($cart_item_key, $product_id) {
    if (!memesh_is_round_product($product_id)) return;
    $tickets = 0;
    foreach (WC()->cart->get_cart() as $item) {
        if (memesh_is_round_product($item['product_id'])) $tickets += 1;
    }
    if ($tickets > 1) return;
    wc_add_notice('הכרטיס נוסף לסל. אפשר להוסיף עוד ילד/ה — גם בתאריך אחר — או לעבור לתשלום.', 'notice');
}, 20, 2);

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

    // One paid seat per child. Every entry ticket is its own cart line
    // (memesh_uid) with quantity locked to 1, so a line should never carry more
    // than one seat. The hold below reserves exactly one seat per call, so if
    // any path ever inflated the quantity we refuse rather than charge for
    // seats we did not reserve.
    if ((int) ($values['quantity'] ?? 1) > 1) {
        throw new Exception('כרטיס כניסה לסבב הוא ליחיד/ה — הוסיפו כל ילד/ה בשורה נפרדת.');
    }

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
    // Per-line idempotency key so two children on the SAME round don't collapse
    // into one held seat (Yanay 2026-07-07). The uid is stable across payment
    // retries (the cart line persists), so a retry still refreshes this line's
    // own hold instead of leaking a second seat.
    if (!empty($values['memesh_uid'])) {
        $body['holdKey'] = $values['memesh_uid'];
    }
    $res = wp_remote_post(MEMESH_API_BASE . '/rounds/hold/wc', [
        'headers' => [
            'Authorization' => 'Bearer ' . MEMESH_SHARED_KEY,
            'Content-Type'  => 'application/json',
        ],
        'body'    => wp_json_encode($body),
        'timeout' => 15,
    ]);

    if (is_wp_error($res)) {
        error_log('[memesh hold] request to API failed: ' . $res->get_error_message());
        throw new Exception('לא ניתן לאשר מקום כרגע. נסו שוב.');
    }
    $code = wp_remote_retrieve_response_code($res);
    $raw  = wp_remote_retrieve_body($res);
    if ($code === 409) {
        // Name the round so a parent with several children knows exactly which
        // line to fix. The whole checkout aborts here before the order exists,
        // so nothing is charged.
        throw new Exception(sprintf(
            'הסבב שנבחר (%s) התמלא זה עתה. הסירו אותו מהסל ובחרו סבב אחר.',
            memesh_round_display($values)
        ));
    }
    if ($code !== 200) {
        // 401 wrong/absent shared secret, 400 bad body, 404 round gone, 503 API
        // missing its own secret — the response body names which. Logged so the
        // WP debug log is self-diagnosing instead of showing only the customer
        // sentence. Never logs the secret (headers are not included here).
        error_log(sprintf('[memesh hold] API returned HTTP %d: %s', $code, $raw));
        throw new Exception('לא ניתן לאשר מקום כרגע. נסו שוב.');
    }
    $data = json_decode($raw, true);
    if (empty($data['holdId'])) {
        error_log('[memesh hold] HTTP 200 but no holdId in body: ' . $raw);
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
