# Scan preview — customer + card details before punching

**Status:** approved 2026-06-19 (Yoav).

## Goal

When a cashier scans a QR (or types a serial), the confirmation modal
must show full customer + card context BEFORE the punch fires. Today
the modal asks for companion count with zero context — the cashier
has no way to verify "is this the right person?" without trusting the
QR blindly. Adding a preview closes the QR-photo-theft mitigation gap
flagged in the scanner security review.

## Locked decisions (2026-06-19)

| Question | Answer |
|---|---|
| Layout | Inside the same modal as the companion picker — one screen |
| Detail level | Everything + full history list |
| Bad card UX | Show details with a red banner explaining the problem |

## Approach

### Backend

**New db function:** `scanCardLookup(db, punchCardId)` in `packages/db/src/cards.ts`.
Returns:
- `customer`: id, customerNumber, firstName, lastName, phone, children
- `card`: id, serial, totalEntries, usedEntries, isActive, expiresAt, cancelledAt, cancelReason, createdAt
- `entries`: full history, newest first (id, punchedAt, companionCount, method, staff name)
- `status`: derived — one of `'ok' | 'exhausted' | 'expired' | 'cancelled'`

Status derivation order matters — a cancelled card may also be exhausted
or expired; show the cancellation since that's actionable.

**New API route:** `POST /scan/lookup` in `apps/api/src/routes/punch.ts`
(or a new `scan.ts` plugin — leaning toward `punch.ts` since it lives
adjacent to the verify-and-find logic).
- Auth: cashier+ (same as `/punch`).
- Body: `{ token?: string, serial?: string }` (one required).
- If `token`: HMAC-verify with `envKeyResolver`. On fail → 401 `invalid_signature`. Audit to `scan_attempts` like `/punch` does.
- If `serial`: lookup by `serial_number`. On miss → 404 `not_found`. Audit.
- Otherwise → 400 `invalid_body`.
- On hit: return the `scanCardLookup` result.
- Rate limit: same as `/punch` (30/min per IP).

### Frontend

**New API client function:** `lookupCard(token | serial)` in `apps/web/src/lib/api/punch.ts`.

**Enhance `PunchConfirmModal`** ([apps/web/src/pos/PunchConfirmModal.tsx](apps/web/src/pos/PunchConfirmModal.tsx)) to take an optional `preview` prop. When present:
- Show a header block: customer name + phone + customer number, children (if any), serial, used/total/remaining, expiry, last visit.
- Show a scrollable history list (date + companion count + staff initials).
- If `preview.status !== 'ok'`: render a red banner ("הכרטיסייה פגת תוקף", "הכרטיסייה נוצלה", "הכרטיסייה בוטלה"), hide the companion picker, and replace the "נקב" button with "סגור".

When `preview` is omitted (customer-detail flow — the cashier is already looking at the customer), the modal behaves exactly as today.

**Scan flow changes** ([apps/web/src/pos/PosApp.tsx](apps/web/src/pos/PosApp.tsx) `Scan()`):
- Add a `'loading-preview'` phase between detection and `'confirming'`.
- On token detect / serial submit: fetch `/scan/lookup`. On failure (signature/not-found): go to `'error'` with the existing humanized messages. On success: store the preview + go to `'confirming'`.
- Pass preview into the modal.

### Tests

**packages/db** — `scanCardLookup` tests:
- Active card returns status `'ok'` with full entry list.
- Exhausted card returns status `'exhausted'`.
- Expired-by-time card returns status `'expired'`.
- Cancelled card returns status `'cancelled'` even if also expired/exhausted.
- Unknown id returns `undefined`.

**Frontend api client** — `lookupCard` test mirrors existing punch.test.ts shape.

### Observability

- `[scan lookup]` on every call with `{ mode: 'token' | 'serial', status }`.
- `[web scan] preview` on the frontend with the same.

### Security

Same risk surface as `/punch`. Token verification is identical (HMAC). Staff
auth required. Failed lookups still write `scan_attempts` so brute-force
attempts against serials are visible.

## Out of scope

- Showing a photo of the customer (no photos in the schema yet).
- Pre-fetching the preview as the camera scans (would require streaming).
- Refreshing the preview if the card state changes mid-modal.
