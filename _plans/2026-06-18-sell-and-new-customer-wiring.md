# New customer + sell wiring + Yanai feedback item 1

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md` (handoff section, write-side surface flips)
Predecessor: `_plans/2026-06-18-punch-wiring.md`

The previous chunk turned on the read+punch path on the POS customer detail. This one closes the daily cashier loop: register a new customer, sell them a card. Also folds in Yanai's feedback item 1 (real required-field enforcement on the new-customer form + a "מומלץ" badge next to the email field).

---

## 1. Goals

- New-customer form on POS calls `POST /customers` with real validation. Required fields (first name, last name, phone) are enforced client-side AND validated by the server's Zod schema. Email field shows a "מומלץ" badge.
- On successful registration the cashier lands straight on the sell screen for that new customer.
- Sell screen "אושר" call POSTs `/cards` with the new customer's id and renders the real serial (M-YYYYMMDD-NNNN) on the success card.
- Customer detail screen gains a "מכירת כרטיסייה חדשה" affordance when the customer has no active card, so a returning customer can buy another one without the cashier flipping back to home.
- Server errors map to Hebrew (`phone_taken`, `invalid_body`, generic).

Success looks like: cashier taps "לקוח חדש" → fills first/last/phone → "מומלץ" pill suggests email → submits → lands on sell screen → "אושר" → sees real serial. Refresh, search the new phone, see the new customer with the new card. End-to-end.

## 2. Locked decisions

### 2.1 Two-stage flow: registration first, sell second

`POST /customers` and `POST /cards` are separate API calls. We don't bundle them into a "register-and-sell" endpoint because:

- A walk-in registration without immediate sale already happens (existing customer asks to be added before deciding).
- Failure modes are isolated: a card-create failure shouldn't roll back the customer registration; the cashier can retry the sell.

The UX still feels one-tap: NewCustomer auto-advances to Sell after a successful POST /customers.

### 2.2 Phone uniqueness: server-side conflict → "מספר הטלפון כבר רשום"

The schema enforces `phone UNIQUE`. The route catches insert failures generically and returns 409 `phone_taken`. We map that to a friendly Hebrew message under the phone field rather than at the top of the form so the cashier knows which field to correct.

### 2.3 Email "מומלץ" badge: small pill next to the label, not after the input

Yanai asked for a hint that nudges staff to capture email. A pill on the label keeps it visible while the cashier is reading the form. The label reads `מייל [מומלץ]` with the pill in our muted-orange. Email itself remains optional.

### 2.4 "מכירת כרטיסייה חדשה" link on Customer detail when no active card

Today the detail screen falls back to "ללקוח אין כרטיסייה פעילה" when no active card exists. Add a button there that jumps to the Sell screen with the customer pre-selected. Costs one button, gains real continuity for the most common follow-up action.

### 2.5 Sell screen uses the selected customer id, not a form

`POST /cards` takes `customerId` only. We already have `selectedId` in PosApp state (the search/detail selection lives there). NewCustomer writes the new customer's id into `selectedId` before navigating; Sell reads from `selectedId`. No new prop drilling.

## 3. Files this chunk produces or modifies

```
apps/web/src/lib/api/customers.ts         # add createCustomer
apps/web/src/lib/api/customers.test.ts    # add createCustomer test
apps/web/src/lib/api/cards.ts             # new: sellCard(customerId)
apps/web/src/lib/api/cards.test.ts        # new: 2 tests (body + 400/409 errors)
apps/web/src/pos/PosApp.tsx               # NewCustomer + Sell wired; recommended pill; sell-from-detail
apps/web/package.json                     # cards.test.ts registered
```

No backend changes.

## 4. Build sequence

1. `createCustomer` + `cards.ts` clients + tests. Confirms request shapes in isolation.
2. NewCustomer rewrite: real form state, validation, "מומלץ" pill, error map, auto-advance to Sell.
3. Sell rewrite: real POST /cards, render the actual serial on success.
4. Customer detail: "מכירת כרטיסייה חדשה" affordance.
5. Verify: typecheck, tests, build, format. Manual end-to-end smoke against the live API.

## 5. Security (rule 13)

- Server enforces auth + role: `POST /customers` and `POST /cards` are both behind `requireRoleHook('cashier','manager','admin')`. The client never gates by role.
- Phone uniqueness is enforced at the schema level; client-side conflict surface is purely a UX hint.
- Email validation: server uses Zod's `z.string().email()` and caps length at 255. Client mirrors with `type="email"` so browser autofill behaves; both sides agree on the contract.
- No new PII surface area beyond what the brief already specifies (first/last/phone/email). Yanai's optional marketing fields stay deferred (waiting on his approval of the list before we add columns; see previous discussion).

## 6. Observability (rule 14)

- `[web newcustomer] submit` with masked phone (first 3 digits visible).
- `[web newcustomer] success` with the new customer id + customerNumber.
- `[web newcustomer] error` with `{ status, error }`.
- `[web sell] submit` with the customerId.
- `[web sell] success` with `{ cardId, serial }`.
- `[web sell] error` with `{ status, error }`.

## 7. Testing (rule 18)

- `customers.test.ts`: add createCustomer test (POST body + customerNumber unwrap).
- `cards.test.ts` (new): (a) sellCard POSTs `/cards` with `{ customerId }`; (b) returns the error union on 400.
- Existing tests stay green (89 total before this chunk, expect ~92 after).

## 8. Settings (rule 15)

No new user-facing settings. Card defaults (12 entries, 1-year validity, ₪320 price) are brief-locked business rules. When the eventual settings surface lands, those become read-only displays plus an admin-only override; not in this chunk.

## 9. Yanai blockers

None for this chunk. Item 1 from his Whatsapp feedback (validation + מומלץ badge) lands here. Item 2 (optional marketing fields) still waits on his approval of the field list.

## 10. Out of scope (deferred)

- Scan QR flow (camera, decode library).
- Customer-area (OTP) wiring.
- Admin surface wiring.
- Optional marketing fields (Yanai item 2).
- Inbound WC webhook (Yanai item 5 / scope decision).
- The Sell screen's success "send SMS" copy stays as a visual placeholder; real SMS dispatch comes later with the 019 SMS provider hookup.

## 11. Alternatives rejected

- **Single "register-and-sell" endpoint.** Bundles two distinct failure modes; rejected.
- **Phone-taken as a top-of-form banner.** Cashier has to look up to read it; inline-under-field is faster to act on. Rejected banner.
- **No auto-advance after registration.** "Save customer, then click Sell" is two taps and an extra screen for the most common path; auto-advance keeps it one beat. Rejected the extra step.
- **Pre-validate phone uniqueness as the cashier types.** Adds a debounced GET /customers?q=... per keystroke. Server already handles 409 cleanly on submit; the per-keystroke check is over-engineering for low collision rates.

## 12. Open questions

None blocking.
