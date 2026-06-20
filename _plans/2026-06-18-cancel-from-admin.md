# Cancel-from-admin button

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-18-cards-list-wiring.md` §10 (out of scope at that time).

Small follow-up: the Cards list view shows active cards but has no way to cancel them. The endpoint `POST /cards/:id/cancel` already exists (manager/admin only, required reason, logs a staff action). This chunk wires the UI.

---

## 1. Goals

- A "ביטול" button on each row in the **פעילות** filter of the admin Cards view.
- Clicking opens a small modal asking for the cancel reason (required, min 1 char).
- On confirm, POST `/cards/:id/cancel` with the reason. On success, the card disappears from active and reappears in **בוטלו** with the reason.
- No cancel button on rows in **שפגו** (would be semantic noise — those are already inactive) or **בוטלו** (would re-cancel).

Success: admin opens Cards → פעילות → sees a card to cancel → tap ביטול → types "לקוח ביקש" → אישור → card vanishes from פעילות, appears in בוטלו with the reason inline.

## 2. Locked decisions

### 2.1 Server-side guard against re-cancelling

`cancelCard` in @memesh/db currently overwrites `cancelledAt`/`cancelledBy`/`cancelReason` regardless of whether the card is already cancelled. Add a guard: if `cancelledAt IS NOT NULL`, return `undefined` (same shape as "not found") so the API surfaces a clean 404 and the client doesn't accidentally rewrite the audit trail.

### 2.2 Modal, not inline prompt

The reason is required and we want it visible while the user types. A `window.prompt` is hostile UX and can't be styled. A small overlay modal matching the existing PunchConfirmModal style is cleaner.

### 2.3 Button visibility

Show only on `status === 'active'` filter rows AND only when `cancelledAt === null` (belt + braces). This means the bulk-render path stays simple — the active filter never includes cancelled rows server-side.

### 2.4 Confirm copy + danger styling

The confirm button uses the existing muted-red palette (matches the cancel badge). Cancel button stays in the ghost style. Header reads "ביטול כרטיסייה" — short and unambiguous.

## 3. Files this chunk produces or modifies

```
packages/db/src/cards.ts                # add guard: cancelCard returns undefined if already cancelled
packages/db/src/cards.test.ts           # +1 test for the guard
apps/web/src/lib/api/cards.ts           # add cancelCardForAdmin(id, reason)
apps/web/src/lib/api/cards.test.ts      # +1 test for the new client
apps/web/src/admin/AdminApp.tsx         # button + modal + refetch
```

No backend route changes (the endpoint already returns 404 when the DB function returns undefined).

## 4. Security (rule 13)

- Endpoint is `requireRoleHook('manager', 'admin')` server-side. Cashiers can't reach it.
- Reason is required (min 1, max 500) — Zod validates server-side. Client validates too for UX.
- Cancellation is logged to `staff_actions` with the acting staff id (from the JWT) and the cancel reason.
- Re-cancel guard prevents an attacker (or a confused admin) from overwriting an existing audit row.

## 5. Observability (rule 14)

- `[web admin cancel]` open / submit / success / error.
- Server already logs `[cards] cancelled`.

## 6. Testing (rule 18)

- db: `cancelCard` returns undefined when called on an already-cancelled card; audit row is NOT duplicated.
- web client: `cancelCardForAdmin` POSTs to `/cards/:id/cancel` with `{ reason }`; surfaces 404 / 400 / 403 cleanly.
- Existing tests stay green.
- Expect ~136 tests after this chunk (was 133).

## 7. Out of scope

- Bulk cancel (multi-select rows).
- Cancel from the POS customer detail screen (staff can already do this; would just be the same modal in a different surface — separate chunk if needed).
- "Undo cancel" (the cancel is intentionally one-way; reactivating a card needs a different design).

## 8. Open questions

None.
