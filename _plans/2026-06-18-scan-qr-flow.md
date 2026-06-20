# Scan QR flow wiring (real camera + decoder + POST /punch by token)

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md` (handoff section).
Predecessor: `_plans/2026-06-18-cancel-from-admin.md`

The POS Scan tile is the last fully-mock surface. This chunk turns it on: real camera, real QR decoding, real `POST /punch` with the scanned token. Manual serial entry stays as the fallback.

---

## 1. Goals

- Cashier taps "סריקת QR" → live camera preview opens immediately.
- A QR code in the frame is detected automatically. On detection: pause the camera, open the existing `PunchConfirmModal` to confirm companion count.
- On confirm: POST `/punch` with `{ token, companions, idempotencyKey }`. Success → green "ניקוב בוצע · נותרו N" + "סריקה הבאה" button. Error → Hebrew reason (signature / expired / exhausted / inactive / not_found) + retry options.
- Manual fallback: "הכניסת מספר סידורי" affordance opens a small input modal; on submit calls `POST /punch` with `{ serial, companions }` (the existing `punchBySerial` path).
- Errors that prevent the camera from starting (permission denied, no camera, insecure context, browser unsupported) show a clear Hebrew explanation + immediately offer the serial fallback.

Success looks like: cashier taps the tile → camera opens within a beat → customer holds phone up → QR detected → cashier picks "2 מלווים" → tap נקב → success line shows remaining count. Tap "סריקה הבאה" → camera reopens.

## 2. Locked decisions

### 2.1 Library: `@yudiel/react-qr-scanner`

Picked over the alternatives:

- vs `nimiq/qr-scanner` (vanilla JS): the React wrapper handles mount/unmount + permissions + facingMode swap as React state, which fits our tightly-controlled `phase` state machine better than imperative .start() / .stop() calls.
- vs `html5-qrcode`: heavier (~3x bundle), brings its own UI we don't want to fight.
- vs hand-rolling `getUserMedia` + `jsQR`: more code, fewer error-category edges handled, more bug surface for one screen.

It uses the native BarcodeDetector API when available (Safari on iPad 17+, all modern Chromium) and falls back automatically. Source reputation is high; library is current as of 2026.

### 2.2 Reuse `PunchConfirmModal` from the punch flow

Same companion-count picker the customer-detail punch button uses. One component, two entry points. Future tweak (1–4 cap, labels, danger styling) lands once.

### 2.3 Idempotency key per scan, not per punch attempt

When the modal opens, generate one `crypto.randomUUID()`. If the cashier double-taps נקב or the network retries, the same key replays on the server (no double-decrement). Closing the modal and re-scanning the same card produces a new key — that's a fresh intent.

### 2.4 Single token per scan

`onScan` gives a `detectedCodes[]` array, but in our domain a frame should never legitimately contain two of our QRs at once. Take the first valid result, ignore the rest, pause the scanner immediately. If the first token is rejected by the server, we surface the error and offer "סריקה חוזרת" — no auto-retry on a moving target.

### 2.5 Token validation lives on the server, not the client

We do not parse / verify the HMAC client-side. The decoded `rawValue` is just a string that the server's `qr-engine` validates via signature + key id. A tampered token, a foreign QR, or a Memesh QR signed with a retired key all surface as `invalid_signature` from the server — which the client maps to a clear Hebrew message.

### 2.6 facingMode: 'environment' (back camera)

The cashier holds the iPad, the customer's phone is across the counter. Back camera is the right default. If the device only has a front camera (rare on iPad), the library falls back automatically.

## 3. Files this chunk produces or modifies

```
apps/web/package.json                       # add @yudiel/react-qr-scanner
apps/web/src/lib/api/punch.ts               # add punchByToken(token, opts)
apps/web/src/lib/api/punch.test.ts          # +2 tests (token POST shape + invalid_signature error)
apps/web/src/pos/PosApp.tsx                 # rewrite Scan() to use real Scanner + serial fallback
```

No backend changes. No new components beyond the inline serial-input modal in Scan().

## 4. Build sequence

1. Install `@yudiel/react-qr-scanner` + refresh lockfile.
2. `punchByToken` in `lib/api/punch.ts` + tests.
3. Rewrite Scan() with phase state machine (`camera` / `confirming` / `submitting` / `success` / `error` / `serial`).
4. Serial fallback: a tiny inline form within Scan() reusing the existing serial path.
5. Hebrew error map for scan errors + punch errors (the latter already exists, just call it).
6. Verify: typecheck, web tests, build, format. Manual smoke is browser-only (no headless camera test).

## 5. Security (rule 13)

- The scan endpoint is rate-limited server-side (30/min per IP). Cashier can't accidentally hammer the API by waving a card at the camera — first detected token wins, rest are dropped until we re-enter `camera` phase.
- The token decoded from the QR is never trusted by the client: the server validates the HMAC signature, the key id, expiry, active flag, and remaining entries.
- `scan_attempts` audit table on the server records both the IP and a hash of the token (never the raw token). Invalid signatures + not-found lookups are logged for replay/abuse review.
- Manual serial fallback hits the same atomic punch transaction (SELECT FOR UPDATE) so a "scan then serial" race on the same card is impossible to double-decrement.
- Camera permission lives in the browser; we never persist it. Camera stops the moment we leave `camera` phase OR the Scan view unmounts.
- We rely on `https` or `localhost` (the library reports `insecure-context` otherwise) — a clear honest error.

## 6. Observability (rule 14)

- `[web scan] mounted` / `[web scan] unmounted`.
- `[web scan] error { kind }` for scanner-level errors (permission, no-camera, etc.).
- `[web scan] detected` with the token's first 8 chars (full token is sensitive PII for replay).
- `[web scan] punch submit / success / error` mirroring the customer-detail punch logs.
- Server already logs `[punch]` and `scan_attempts` rows.

## 7. Testing (rule 18)

- `punch.test.ts`: +2 tests verifying `punchByToken` POSTs `{ token, companions, idempotencyKey }` to `/punch` and unwraps the same response shape; surfaces 401 `invalid_signature` cleanly.
- Existing 38 web tests stay green. Total target: ~140.
- The camera + decoder path is **manual-tested only** in this chunk. Headless browser camera tests need a recorded video fixture, a virtual camera device, or playwright with permission grants — out of scope. Manual recipe in the handback.

## 8. Settings (rule 15)

- No new operator-facing settings. Camera + facingMode are baked.
- Future: a "use front camera" setting for accessibility (camera-flip is a one-line `constraints.facingMode` change); not now.

## 9. Yanai blockers

None for development. For production a real device test on the actual iPad (or whatever hardware Yanai picks) is recommended — the camera UX is the kind of thing simulator testing misses.

## 10. Out of scope (deferred)

- Camera swap UI (front/back). Library supports it via prop; we don't render the control.
- Torch / flashlight control for low-light. Library supports it.
- Batch scan (scan many cards in a row without re-tapping). Not in brief.
- Sound feedback on a successful scan. Optional UX polish.
- Saving "last camera used" to localStorage. Solo-cashier iPad, not needed.
- A camera test fixture for automated regression. Out of scope here.

## 11. Alternatives rejected

- **Hand-rolled `getUserMedia` + `jsQR`.** More code, more edge cases handled by us instead of the library. Rejected.
- **`html5-qrcode`.** Brings its own UI; bundle ~3x; fighting it for RTL styling. Rejected.
- **No companion-count modal — assume 1 every scan.** Faster, but the brief explicitly tracks companions per entry for audit. Rejected.
- **Auto-retry on invalid_signature.** Could hide a tampered token from staff. Better to surface and let them try again. Rejected.

## 12. Open questions

None blocking. Open polish items for a future chunk: torch toggle, scan sound, camera-swap.
