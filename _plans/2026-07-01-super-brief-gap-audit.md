# Super-brief gap audit — what's built vs Yanay's spec

**Date:** 2026-07-01
**Source of truth:** `memesh-rounds-super-brief.md` (Yanay's full spec)
**Method:** verified against the codebase, not memory. Status is ✅ done / 🟡 partial / ❌ not built.

## Built (the ~15%)

- Data schema: `rounds`, `round_instances`, `bookings`, `waitlist_entries` tables with all columns/enums.
- Admin: define rounds + materialize per-date instances (PR #33).
- Admin dashboard: reads today's occupancy, stats, waitlist, week-ahead (#29/#30) + dashboard display settings (#30).
- Staff: read-only "today's rounds" status view (#31).
- Round pricing values stored in `card_settings` + used for the dashboard's revenue math.

Everything below is the actual operating product, and it is not built.

## Gap map (by super-brief section)

| § | Requirement | Status | Note |
|---|---|---|---|
| 1 | Data model / tables | ✅ | rounds, round_instances, bookings, waitlist_entries all exist |
| 1.2 | Generic settings store for operational params | ❌ | only round *prices* exist (card_settings); no home for hold TTL, windows, etc. |
| 1.3 | Availability calculation (customer-facing) | ❌ | dashboard computes occupancy internally; no `/rounds/availability` |
| 2 | Purchase journey (select → hold → pay → confirm) | ❌ | none of it |
| 3 | **HOLD mechanism** (race-safe, 15-min TTL, lazy expiry + sweeper) | ❌ | the brief's "most important part" — not started |
| 3.4 | Punch-card hold + group-buy (N punches, one txn) | ❌ | |
| 4 | **WooCommerce integration for rounds** (products 1001/1002/1003, line-item meta, mint extension, webhook) | ❌ | existing WC is punch-card only |
| 5 | Booking state machine (held→confirmed→used, cancel/expire) | 🟡 | enums exist; no transitions — nothing creates or moves a booking |
| 6.1 | Swap round (atomic, until start) | ❌ | |
| 6.2 | Cancel (24h window) + WC refund + punch return | ❌ | **no refund capability exists at all** |
| 7 | Gift purchase for rounds | ❌ | gift flow exists for cards, not extended to rounds |
| 8 | Waitlist logic (join, FIFO notify, claim, timeout, quiet hours) | 🟡 | table exists + dashboard reads counts; nothing creates/promotes entries |
| 9 | Stay reminders (end-of-round batch, skip last) | ❌ | |
| 10 | Barcode HMAC for round bookings + staff scan→used + name+round search | 🟡 | HMAC exists for *cards*; round `barcode_token` never minted; no round scan/search |
| 11.1.1 | Admin main dashboard | ✅ | built (#29/#30); alerts zone deferred (returns empty) |
| 11.1.2 | Admin management: per-date capacity override/closure, pricing UI, config (TTL/reminders/policy), bookings view+cancel, barcode regen, reports | 🟡 | only round *template* CRUD (#33). Round prices exist in DB/API but have **no editable UI**. The rest not built |
| 11.2 | Staff shift panel: name+round search, scan/punch→used, in-place swap, walk-in sale, companion availability, id-check policy | 🟡 | only the read-only status view (#31) |
| 11.3 | Customer personal area for rounds: bookings + barcode, swap, add companion, punch balance, waitlist status, gift alerts | ❌ | customer area shows punch cards only |
| 12 | Upsell logic (per-ticket + group-buy layer, 5 placements, settings) | ❌ | none |
| 13 | Selection views (calendar / list / tiles widget) | ❌ | |
| 14 | Terms checkbox incl. socks rule (blocks checkout) | ❌ | no terms text, no socks setting |
| 15 | Admin parameters master list (~25 params) | 🟡 | only round prices + dashboard display settings + round default_capacity. ~20 operational params (hold_ttl, active_hours, claim_window, cancellation_window, reminder_offsets, closing_time, companion_min_age, companion_id_check_policy, walkin price, max_children, upsell knobs, terms text, sock_sales) have no storage or UI |
| 16 | Edge cases (oversell, hold-expiry-mid-pay, full-swap, etc.) | ❌ | all depend on the unbuilt flow |

## API surface (Appendix A) — endpoint checklist

| Endpoint | Built |
|---|---|
| `POST /rounds/availability` | ❌ |
| `POST /rounds/hold` + `/hold/release` | ❌ |
| mint extended for rounds | ❌ |
| `POST /rounds/swap` | ❌ |
| `POST /rounds/cancel` | ❌ |
| `POST /waitlist/join` + `/claim` | ❌ |
| `GET /bookings/{customer_id}` | ❌ |
| `POST /staff/lookup` (name+round) | ❌ |
| `POST /staff/punch` (round scan→used) | ❌ |
| `POST /staff/walkin` | ❌ |
| Admin CRUD: rounds ✅ · instances 🟡 · settings 🟡 · pricing 🟡 | partial |

## Bottom line

Built: the schema, the admin rounds definition, the admin dashboard + its settings, and a read-only staff view. That is the skeleton and the mirror.

Not built: the hold engine, the purchase flow, all WooCommerce-for-rounds wiring, minting bookings, barcodes/scanning for rounds, swap, cancel, refunds, the customer personal area for rounds, waitlist automation, reminders, upsell, selection views, the terms/socks gate, and ~20 of the ~25 configurable settings.

The plan in `2026-07-01-rounds-purchase-and-management-flow.md` covers the core spine (availability → hold → WC → mint → booking → personal area → swap → cancel/refund). This audit shows the brief is wider than that spine: it also includes gift-for-rounds, reminders, upsell, selection-view widget, terms/socks, staff shift operations, and the full settings surface. All of it is Phase 1 per §17.
