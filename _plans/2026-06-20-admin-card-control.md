# Admin full card control — assign, reassign, create-with-overrides, remove

**Status:** approved 2026-06-20 (Yoav).

## Goal

Give admins (only) full hands-on power over cards: create a card for any
customer with custom totalEntries/validityDays/source, reassign an existing
card to a different customer, and remove (cancel) cards — all from the admin
UI without round-tripping through the cashier flow.

## Locked decisions

| Question | Answer |
|---|---|
| Reassign semantics | Card moves WITH entries + counters intact. New owner inherits state. |
| Remove | = Cancel (existing flow). Just expose a Cancel button on each card in customer view. |
| Create overrides | Full: customer + totalEntries + validityDays (with forever toggle) + source. |
| Who | Admin only. |

## Brutally honest notes

- **Reassign is destructive to history coherence.** The new owner inherits a
  card that was punched by someone else. The history list will show old
  staff names + dates. Show this in the UI clearly (a row in the entries
  list captioned "הועברה ללקוח זה ב-{date}" — like a divider).
- **No new endpoint for "remove".** Cancel already does the right thing. The
  feature is purely UI discoverability.

## Backend

### db

1. **Extend `createPunchCard`** to accept `validityDays?: number | null`:
   - `undefined` → use `settings.validityDays`
   - `null` → forever (expiresAt: null)
   - `number ≥ 0` → use this value (0 = forever)
2. **New `reassignCard(db, { cardId, newCustomerId, staffId })`**:
   - Tx-locked SELECT card
   - 404 if card or new customer missing
   - 409 if new customer === current customer (no-op)
   - 409 if card is cancelled (can't reassign a dead card)
   - UPDATE punch_cards SET customer_id, updated_at
   - Log staff_action 'reassign_card' with from→to customer numbers
3. **New StaffActionType `'reassign_card'`** (frontend mirror updated too).

### API

1. **POST /admin/cards** (admin only)
   - Body: `{ customerId, totalEntries?, validityDays?: number | null, source? }`
   - validityDays validation: omitted | null | int 0..3650
   - Calls extended `createPunchCard` with overrides
   - Logs nothing extra (createPunchCard already wires through the standard `created` log)
2. **POST /cards/:id/reassign** (admin only)
   - Body: `{ customerId: uuid }`
   - Maps reassignCard failures to 404 / 409 with reason codes:
     - `not_found`, `customer_not_found`, `card_cancelled`, `same_customer`

### Tests (db)

- createPunchCard with `validityDays: 0` → expiresAt null
- createPunchCard with `validityDays: 7` → expiresAt = now + 7d, ignoring settings
- createPunchCard with `validityDays: undefined` → uses settings (existing test)
- reassignCard moves a card and preserves usedEntries + entries
- reassignCard refuses unknown card / unknown customer / same customer / cancelled card
- staff action logged with from→to customer numbers

## Frontend

### API client

- `createCardForAdmin({ customerId, totalEntries?, validityDays?, source? })`
- `reassignCard(cardId, newCustomerId)`

### Admin Customer Detail modal — cards section

- New "+ כרטיסייה חדשה" button next to the כרטיסיות header
- Per-card row: add an action button cluster
  - "פרטים" → opens the existing card detail modal (which has refund-entry, etc.)
  - "ביטול" (active cards only, role permitting) → opens existing Cancel modal
  - "העברה" (active cards only) → opens new Reassign modal

### New modals

1. **CreateCardForAdminModal**
   - Fixed customer (passed in) — no need to pick
   - Fields:
     - totalEntries (number, default = settings.totalEntries)
     - "ללא תפוגה" toggle + validityDays input (matching the settings UI)
     - source select: `manual` (default) / `pos` / `online`
   - "צור כרטיסייה" submit
2. **ReassignCardModal**
   - Shows the card serial + current owner
   - Customer search input (uses existing `searchCustomers` endpoint, debounced)
   - Pick a result → confirm
   - "העברה" submit with confirmation modal that explains "ההיסטוריה תישאר על הכרטיסייה"

### Permissions

- Buttons only render when `cardsRole === 'admin'`. Manager + cashier see nothing new (they still see the cards list).

## Observability

- `[reassign] submit` with `{ cardId, fromCustomerId, toCustomerId, staffId }`
- `[admin create-card] submit` with `{ customerId, totalEntries, validityDays }`
- Both `[…] success` / `[…] error` shapes.

## Out of scope

- Hard-delete cards (user picked "cancel = remove").
- Bulk operations (assign N cards to N customers).
- Card transfers between branches / accounts (multi-tenant).
- Self-service customer-initiated reassign requests.
