# Staff-editable customer phone (admin app)

Date: 2026-07-12
Requested by: Yanay (a customer asked to change her phone number; staff found it blocked)

## Goal

Let admin/manager staff change a customer's phone number from the admin
customer-detail screen, safely. Today there is no write path for phone at all:
`customers.phone` is `NOT NULL UNIQUE` and was treated as an immutable identity
key, so `apps/api/src/routes/customers.ts` only exposes POST/GET/DELETE. The
customer-facing profile edit disables the field with "לא ניתן לשנות טלפון · פנו
לצוות", and `updateCustomerProfile` in `packages/db/src/accounts.ts` explicitly
excludes phone with the comment "may only be changed by staff". This builds the
missing staff path.

## Why it is safe

- Everything that binds to a customer keys off `customer_id` (punch cards,
  bookings, login tokens/sessions). Those are unaffected by a phone change.
- SMS is sent to whatever number is on the record. Updating a customer who
  changed numbers *fixes* SMS delivery; leaving the dead number is the harm.
- The one real hazard is a uniqueness collision with another customer, plus
  making sure the new number is normalized the same way registration does so
  future WooCommerce reconciliation (`resolveOrCreateCustomerFromWc`, matches by
  normalized phone) still lines up. Both are handled below.

## Scope (chosen)

Admin app only, with an explicit confirm step. Not surfaced in the POS/staff
app. Role gate: `admin` + `manager` (mirrors the delete route; cashiers excluded).

## Approach

1. **DB** `packages/db/src/accounts.ts` — `updateCustomerPhone(db, id, phone, now?)`.
   Runs in a transaction. Discriminated result:
   `{ ok: true, customer, changed }` | `{ ok: false, reason: 'not_found' }` |
   `{ ok: false, reason: 'phone_taken' }`. No-op (changed:false) when the new
   phone equals the current one. Pre-checks another customer holding the phone
   and also catches the unique-violation as a race backstop. Phone arrives
   already normalized from the route (same contract as `createCustomer`).

2. **API** `apps/api/src/routes/customers.ts` — `PATCH /customers/:id/phone`,
   `requireRoleHook('admin', 'manager')`. Body `{ phone: phoneSchema }` (the same
   normalizer every other write uses). uuid-checks the id. Maps `not_found`→404,
   `phone_taken`→409. On a real change: `request.log.info` old→new and
   `logStaffAction(action:'other')` for the audit trail. Returns `{ customer }`.
   Known limitation logged, not fixed: the linked WordPress user keeps its old
   phone-as-username (cosmetic; customer login is phone+OTP against Memesh, not WP).

3. **Admin client** `apps/admin/src/lib/api/customers.ts` — `updateCustomerPhone(id, phone)`.

4. **Admin UI** `apps/admin/src/admin/AdminApp.tsx` — an edit affordance by the
   phone in `CustomerDetailBody`, opening a small confirm modal (new number input
   + "save" that shows old→new and asks to confirm). Wired through
   `CustomerDetailModal` with its own submitting/error state, refreshes detail on
   success. Error copy for `phone_taken` ("המספר כבר משויך ללקוח אחר") and invalid.

## Alternatives rejected

- In-place edit with no confirm: faster but a typo silently reroutes SMS to a
  stranger. Rejected for a low-frequency, high-blast-radius action.
- Fold into `updateCustomerProfile`: that function's whole point is "everything
  except phone". Phone needs collision semantics and its own audit line; a
  dedicated helper keeps the SSOT clean.
- Surface in POS/staff app too: out of the requested scope; can add later.

## Security

Role-gated to admin/manager (same as delete). Input normalized + length-bounded
via `phoneSchema`. Uniqueness enforced at DB and re-checked in-tx. No PII beyond
the phone itself in logs (old→new phone is operationally necessary for the audit
trail and already visible to the acting staffer).

## Observability

`[customers] phone changed { id, from, to }` on success; `logStaffAction` row.
`phone_taken` and validation failures logged at warn.

## Testing

- DB (`accounts.test.ts`): success changes phone; not_found; phone_taken on
  collision with another customer; no-op when unchanged.
- API (`customers.test.ts`): 401 no token; 403 cashier; 400 invalid phone; 400
  invalid id.

## Deploy

Feature code only, no schema migration (reuses existing columns + action enum
value 'other'). Ships via PR into `main` per the normal flow; nothing promoted
by hand.
