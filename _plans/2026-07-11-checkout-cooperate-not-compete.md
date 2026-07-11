# Checkout +/-: cooperate with the site's own widget, stop competing

Date: 2026-07-11
Source: Yanay's DevTools capture + "leave the [Memesh Checkout] snippet as is
and surgically do only the changes that are needed."

## Root cause (finally pinned, with the source in hand)

The checkout +/- come from the site's **"Memesh Checkout"** snippet, function
#15 (`woocommerce_checkout_cart_item_quantity`), which renders
`.memesh-qty-controls[data-cart-key]` with `.memesh-qty-btn`/`.memesh-qty-remove`
buttons and its own AJAX quantity updater. My rounds snippet had been rendering
competing controls with colliding class names and a global click listener that
hijacked that widget's buttons (companion "+", punch-card bump). Every "weird"
screenshot traces to that collision.

Deeper truth: letting a round ticket bump quantity is fundamentally
incompatible with one-seat-per-line holds (the hold code rejects qty > 1). So
the ticket "+" must add a new line via the picker, never bump.

## Change (all in the rounds snippet; the Memesh Checkout snippet is untouched)

Removed the competing machinery: the `woocommerce_cart_item_quantity` markup
filter, the `woocommerce_after_cart_item_quantity_update` clamp, the
`woocommerce_quantity_input_args` pin, the companion `sold_individually` +
`found_in_cart` bypass, and the button-swap JS. `sold_individually` stays for
round products only (product-page one-per-line), as it was at 07-07.

Added cooperation: `memeshDecorateCheckoutRows()` tags the site widget's rows
by `data-cart-key` against the server-printed `memeshCartLines` map —
companion (t=0) → `.memesh-companion-frozen` (whole controls block hidden via
CSS), round-ticket (t=1) → `.memesh-ticket-row` (CSS hides its −/input, leaving
"+" and "×"). Re-runs on `updated_checkout` / fragment refresh. Punch cards and
other products aren't in the map, so they stay fully native.

Correctness lives in the capture-phase click handler (preempts the widget's own
bubble-phase delegated handler): it reads the map live, so companion clicks are
swallowed and a round-ticket "+" opens the add-ticket picker — even if a row
hasn't been class-decorated yet (mid AJAX re-render). The dashed "add another
child" button stays as the guaranteed add path (it's the only one on the /cart
page, where the widget doesn't render).

Net checkout behavior: companion line frozen (no +/-/×; auto-managed with its
ticket); round-ticket line shows "+" (opens the date/round picker → new line)
and "×" (remove); punch cards keep normal quantity.

## Testing

Snippet (PHP + inline JS) — no repo test harness by convention. Manual QA on
the live site after paste + LiteSpeed CSS/JS purge:
1. Checkout: companion line has no controls; ticket line shows only + and ×.
2. Ticket "+" opens the picker on that line's date; choosing a round adds a new
   ticket line; page reloads showing it.
3. Ticket "×" removes the line and its companion.
4. Punch-card line (if present) still has working native +/-.
5. Edit billing (triggers updated_checkout) → decoration re-applies, no flch.
6. No doubled buttons, no dateless modal, no punch-card hijack.

## Deploy

Merging deploys nothing. Rollout: paste the regenerated
`2026-07-11-yanay-snippet.txt`, purge LiteSpeed (LSCache + CSS/JS), hard-refresh.
The Memesh Checkout snippet is not modified — do not re-paste it. Rollback:
re-paste `2026-07-07-yanay-snippet.txt`.

## Revision (2026-07-11, after the first live test of this approach)

A console dump proved the JS ran perfectly — both rows carried the right
classes (`memesh-ticket-row`, `memesh-companion-frozen`) — but the companion
stayed visible and the ticket "+" was greyed. Two causes:
1. The embedded `<style>` rules never applied: LiteSpeed served a stale
   combined CSS bundle without them (JS wasn't combined, so it ran fresh).
2. Our `sold_individually` makes the round ticket max-purchase 1, so the
   Memesh Checkout widget rendered the ticket "+" `disabled`.

Fix: do the freezing/trimming with INLINE styles inside
`memeshDecorateCheckoutRows()` (immune to CSS cache-stripping, beats the
widget's CSS), and force-enable the ticket "+" (remove `disabled` +
`memesh-qty-disabled`), since we own its behavior. Companion detection now also
honors the widget's own `data-is-companion="1"` as a fallback. The embedded CSS
rules for these were removed so the visual contract lives entirely in the JS.

## Follow-up

Version the site's own cart snippets (now exported under `WP SNIPPETS/`) into
the repo after a secrets check, so this invisible-code collision can't recur.
