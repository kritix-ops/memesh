# Punch flow wiring (POST /punch by serial)

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md` (handoff section, write-side surface flips)
Predecessor: `_plans/2026-06-18-fe-caveats-and-search-wiring.md`

The previous chunk wired the read side of the POS customer flow (search + detail) and intentionally left the punch button disabled. This chunk turns punch on: the cashier can decrement a customer's punch card from the POS detail screen, with a companion count, against the real API, with server-side idempotency.

---

## 1. Goals

- Pressing "ניקוב כניסה" on a customer's detail screen pops a small confirmation modal asking how many companions (1–4), then calls `POST /punch` with the active card's serial number, the companion count, and a per-intent idempotency key.
- On success, the customer's pebbles update live (refetched from the API) and a brief inline success line appears below the punch button ("✓ נוצב · נותרו N").
- On error, a human-readable Hebrew message replaces that line — using the actual server reason (`exhausted`, `expired`, `inactive`, `not_found`, `invalid_signature`).
- Idempotency: the per-intent key is generated once when the modal opens, so a duplicate click while in-flight or a network retry are no-ops on the server.

Success looks like: search → click customer → tap "ניקוב כניסה" → pick "2 מלווים" → tap "נקב" → pebble grid updates from N to N+1, "✓ נוצב · נותרו 5" appears for ~2.5s. Press it again — works again, and the server records two distinct entries.

## 2. Locked decisions

### 2.1 Punch by **serial**, not QR token

QR scanning is a separate, larger chunk (camera wiring, decode library, fallback UI). For now the detail screen knows the active card's `serialNumber` so we call `POST /punch` with `{ serial, ... }`. The API already supports this — it's the "human fallback" path the brief calls out (§7) and treats with the same atomicity as a scan.

When the scan UI lands, it'll use the same `lib/api/punch.ts` module with `{ token, ... }` instead.

### 2.2 Idempotency key: `crypto.randomUUID()` per modal open

The browser generates the key once when the modal opens (`useState` initializer). The same key flies on every "נקב" click in that modal session, so double-tapping or a network retry returns a `replay: true` from the server, not a second decrement. Closing and re-opening the modal generates a new key (a new intent).

Rejected: a per-click key. Defeats the point of idempotency — the user's _intent_ is one punch, not one network packet.

Rejected: server-generated keys returned on a first round-trip. Two round-trips for one intent; the client-generated UUID has 122 bits of entropy and is fine.

### 2.3 Pebbles update via refetch, success indicator inline

After a successful punch, we call `getCustomerDetail(id)` again. Simpler than reconciling the local `detail` state with the API's `{ remaining, usedEntries, totalEntries }` shape. The refetch is ~10ms in practice; the user perceives it as instant. The history list updates correctly too.

The success indicator is a small `[✓ נוצב · נותרו N]` line below the punch button that auto-hides after 2500ms. No global toast (we removed the toast machinery last chunk; adding it back for one feature would re-introduce churn).

### 2.4 Companion count: 1–4, default 1

Server enforces `1 ≤ companions ≤ 4` (Zod). The modal mirrors with `+`/`−` stepper buttons. Initial value is 1.

### 2.5 Punch only when there IS an active card

The disabled punch button stays disabled if `pickActiveCard(cards)` is undefined (no card, or card is `is_active=false`). The Customer screen already handles "no active card" with the existing fallback message; that path renders no punch button at all.

## 3. Files this chunk produces or modifies

```
apps/web/src/lib/api/punch.ts             # new: punchBySerial + types
apps/web/src/lib/api/punch.test.ts        # new: 3 tests — happy path + replay flag + error shape
apps/web/src/pos/PunchConfirmModal.tsx    # new: overlay + companion stepper + confirm button
apps/web/src/pos/PosApp.tsx               # enable punch button; wire modal; refetch on success
apps/web/package.json                     # add punch.test.ts to the test script
```

No backend changes. The endpoint contract is already correct.

## 4. Build sequence

1. `lib/api/punch.ts` + tests. Confirms the request shape and response unwrapping in isolation.
2. `pos/PunchConfirmModal.tsx`. Pure component; takes props (`onClose`, `onConfirm(companions)`, `submitting`).
3. Update `PosApp.tsx` Customer screen to enable the punch button + open the modal + handle confirm + refetch.
4. Verify: typecheck, tests, build, format. Then manual test against the live API.

## 5. Security (rule 13)

- The endpoint is already behind `requireRoleHook('cashier','manager','admin')` server-side. The client never gates by role; the API is the boundary.
- Idempotency keys are 122-bit UUIDs; they are NOT secrets but they are also not predictable. The server uses them only to dedupe within a card's `punch_card_entries` rows.
- The `terminalId` field is omitted in this chunk (web app — no concept of a terminal id yet). When that lands, it's audit-only.
- Errors never reveal whether a serial exists for another customer. The detail screen only renders the active card belonging to the customer we already loaded by id; the punch call targets that exact serial.

## 6. Observability (rule 14)

- `[web punch] open` when the modal mounts (with serial + idempotency key prefix, not the full key).
- `[web punch] submit` on confirm with `{ companions }`.
- `[web punch] success` with `{ remaining, replay }`.
- `[web punch] error` with `{ status, error }`.
- Server side already logs `[punch] invalid token` etc.

## 7. Testing (rule 18)

- `punch.test.ts`: (a) sends the right path + body + method; (b) unwraps a successful response including `replay: true` round-trip; (c) returns the error union on 409 `exhausted`.
- Manual test recipe in the handback at the end of the chunk: log in, create a customer with a card, punch via the UI, verify entry row + decremented `used_entries` in the DB.

## 8. Settings (rule 15)

No new user-facing settings. Companion cap (1–4) is a brief-locked business rule. Auto-hide of the success indicator (2500ms) is a hardcoded UX micro-detail — surfacing it as a setting would be over-engineering.

## 9. Yanai blockers

None. Stand-alone client wiring against an already-built endpoint.

## 10. Out of scope (deferred)

- QR scan flow (camera + decode + token-path punch). Big chunk on its own.
- Sell card flow (POST /cards). Next after this.
- Undo last punch (no API endpoint exists; would require a soft-delete pattern or a dedicated reversal endpoint with audit row).
- Per-terminal id wiring (requires a terminal-registration concept the brief doesn't define yet).
- Real-Postgres atomic-punch concurrency test (deferred in handoff §still-deferred). The endpoint is tested at the unit level with PGlite; a two-connection live race test belongs in its own follow-up.

## 11. Alternatives rejected

- **Optimistic update without refetch.** The punch response gives us enough to update the pebbles, but the history list would drift. Refetch is one extra ~10ms call and keeps the screen honest. Rejected optimistic-only.
- **Modal replaced by an inline stepper.** Tested mentally — too easy to misclick the count vs the confirm in a single tap target. Modal forces the explicit confirm beat, matches the existing pattern from the now-removed askCompanions overlay.
- **Toast instead of inline success.** Adding global toast machinery back for one feature is more churn than the inline indicator. Toast can come back if a second feature needs it.
- **Per-click idempotency key.** Defeats the dedupe property. Rejected.

## 12. Open questions

None blocking.
