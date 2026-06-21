# Staff/Admin login: email as username + Forgot Password

Date: 2026-06-21
Branch: feat/phase1-secure-core
Owner: Yoav

## Goal

Today every staff member (admin, manager, cashier) logs into the web apps with
phone + password. Yoav wants the username to be the **email** for staff and
admins instead of phone. Phone remains in the schema as a unique contact ID,
but it is no longer the login identifier. He also wants a "forgot password"
flow.

Success criteria:

1. The staff login form accepts `email + password` (no phone field at login).
2. Admin and manager rows must have an email; cashier rows may still have no
   email (cashier attribution at the till uses PIN, not email).
3. Email is unique across staff (case-insensitive). Phone stays unique.
4. A "שכחתי סיסמה" link on the login form lets a staff member request a reset
   link to their email. The link opens a reset-password form that sets a new
   password and signs them in.

Out of scope:

- Customer-area login (continues to use phone OTP + email OTP fallback).
- Cashier PIN flow at the till (separate concern; PIN is for attribution).
- Multi-factor auth / email verification on first login (future).
- Self-service "change my password while signed in" (future, easy follow-up).

## Why now

Yoav explicitly asked for the change. It also fixes two practical issues:

- Phones get reassigned and reused; emails are stickier as a login identity.
- A staff member whose phone changes today loses their login. With email as
  the username, the phone can be updated by an admin without churning the
  credential.

## Constraints

- The schema, migrations, and login UI all need to change together — partial
  rollout breaks the login form.
- Existing rows: there is at least one seeded admin with `email = null`. The
  migration must not break the existing admin's ability to log in. We resolve
  this by keeping the column nullable, adding a **partial** unique index
  (`WHERE email IS NOT NULL`), and requiring email at the application layer
  when role ∈ {admin, manager}. Existing admin rows without email need a
  one-time backfill (seed-admin can be re-run with SEED_ADMIN_EMAIL set, or
  the admin updates their own row via the staff routes once they're in).
- The forgot-password email goes through the existing `@memesh/email`
  provider seam (Console in dev, Resend in prod). No new vendor.
- The reset URL must work across subdomains; reset link points to
  `STAFF_LOGIN_URL` (env-driven), defaults to `https://staff.memesh.co.il`.

## Alternatives considered

### A. Accept either email OR phone in the login form (transition mode)

Lookup tries email first, falls back to phone. Keeps the existing UX working
for users who haven't been told about the change.

Pros: smooth transition; nothing breaks.
Cons: contradicts the user's literal request ("username should be the email
and NOT the phone"); doubles the login surface area; confusing for support.

### B. Email-only login, partial unique index on email, role-gated requirement *(chosen)*

Login form takes email only. Server looks up by email. Admin/manager rows
require email (route-layer validation). Cashier rows may still have no email
(they don't need to log in; cashier attribution uses PIN). A partial unique
index ensures email collisions surface as 409 at write time without forcing
nullable rows to take a sentinel value.

Pros: literally matches the user's request; one clear lookup path; least
ambiguous for future maintainers; small migration; works with the existing
nullable column.
Cons: existing admin rows with `email = null` cannot log in until an email
is added — one-time chore handled by re-running seed-admin with
SEED_ADMIN_EMAIL set, or by an existing admin updating the row via the
staff routes.

### C. Email-only login, email becomes NOT NULL for every staff

Cleanest schema (no partial index, no nullable column), but forces a value
into every existing row whether or not that staff has an email. Either we
fabricate placeholder emails (terrible — they become live credentials) or
we delete cashier rows that have no email (terrible — destroys data).

Pros: simplest schema.
Cons: data destruction or fake-email anti-pattern.

**Recommendation: B.**

## Design

### DB (packages/db)

1. **Schema** (`packages/db/src/schema/staff.ts`):
   - Keep `email` as `varchar(255)` nullable.
   - Add a unique index on `lower(email)` where `email IS NOT NULL`.

2. **New table** (`packages/db/src/schema/staff-password-resets.ts`):
   ```ts
   staff_password_resets {
     id: uuid PK
     staff_id: uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE
     token_hash: varchar(64) NOT NULL UNIQUE  // SHA-256 hex
     expires_at: timestamptz NOT NULL
     consumed_at: timestamptz
     created_at: timestamptz NOT NULL DEFAULT now()
   }
   ```
   - Token shape mirrors `customer_login_tokens`: raw token is 32 random bytes
     base64url (≈256 bits entropy), only the SHA-256 hash is persisted.
   - Single-use: consume via `UPDATE ... WHERE consumed_at IS NULL`.
   - TTL: 30 minutes (long enough for the email to arrive + the user to act,
     short enough to limit replay window).

3. **Repo** (`packages/db/src/staff-password-resets.ts`):
   - `mintStaffPasswordReset(db, { staffId, ttlMs?, now? })` → `{ raw, expiresAt }`.
   - `consumeStaffPasswordReset(db, rawToken, { now? })` → success returns
     `staffId`; failure returns `'invalid_or_consumed' | 'expired'`.
   - `invalidateStaffPasswordResets(db, staffId, now?)` — called after a
     successful reset to burn any other outstanding tokens for that user
     (defense in depth).
   - `cleanupStaffPasswordResets(db, { keepAfterExpiryMs?, now? })` — cron
     hook, mirrors `cleanupHandoffTokens`.

4. **Helper** in `packages/db/src/accounts.ts`:
   - `getStaffByEmail(db, email)` → case-insensitive lookup using
     `lower(email) = lower($1)`. Used by the login + forgot-password routes.

5. **Migration** (`drizzle-kit generate` produces a single SQL file):
   - `CREATE TABLE staff_password_resets ...`
   - `CREATE UNIQUE INDEX staff_email_lower_unique ON staff (lower(email)) WHERE email IS NOT NULL;`

### Backend (apps/api)

1. **`POST /auth/login`** (apps/api/src/routes/auth.ts):
   - Body becomes `{ email, password }` (was `{ phone, password }`).
   - `email` validated with `z.string().email().max(255)` and lowercased.
   - Lookup via `getStaffByEmail`. On miss / `!isActive` / `!passwordHash`:
     401 `invalid_credentials` (no enumeration).
   - On password mismatch: 401 `invalid_credentials`.
   - On success: same JWT issuance as today.
   - Logs: `[auth login] attempt`, `[auth login] rejected`, `[auth login] issued`
     (existing pattern, just the field name in the log changes from `phone` to `email`).

2. **`POST /auth/forgot-password`** (new):
   - Body: `{ email }`.
   - Always responds 200 `{ ok: true }` regardless of whether the email is
     on file — same no-enumeration discipline as customer OTP routes.
   - When an active staff row with the email exists AND has a passwordHash
     (otherwise there's nothing to reset), mint a token and email a link:
     `${STAFF_LOGIN_URL}/?reset_token=${raw}`.
   - Rate-limit at most one outstanding mint per minute per staffId
     (mirrors `RESEND_COOLDOWN_MS` in email-otp).
   - Logs: `[auth forgot] requested`, `[auth forgot] sent`, `[auth forgot] skipped`
     (with reason, never echoing whether the email is on file in the response).

3. **`POST /auth/reset-password`** (new):
   - Body: `{ token, newPassword }` (newPassword: min 8, max 256).
   - Consume the token. If invalid/expired → 400 `invalid_token`.
   - On success: hash the new password, update `staff.passwordHash`, then
     `invalidateStaffPasswordResets` for that user. Return 200 `{ ok: true }`
     (the client then redirects to the login form with a success banner).
   - We deliberately do NOT auto-sign-in: simpler UX, fewer cookie edge
     cases, and the user already has the new password they just set.
   - Logs: `[auth reset] consumed`, `[auth reset] success`, `[auth reset] rejected`.

4. **`POST /staff` and `PATCH /staff/:id`** (apps/api/src/routes/staff.ts):
   - On create: when `role ∈ {admin, manager}`, require non-empty `email`.
     Return 400 `email_required_for_role` when missing.
   - On both create and patch: catch unique-violation (`23505`) on email and
     return 409 `email_taken`.
   - On patch: if changing role to admin/manager and the row has no email,
     refuse with 409 `email_required_for_role` so an admin can't be created
     by elevation without an email.

5. **Env** (apps/api/src/config.ts):
   - Add `STAFF_LOGIN_URL` (optional URL). Default in dev:
     `http://localhost:5173` (the staff app dev port — confirm against
     vite.config). Used to build reset URLs.

### Frontend (apps/admin, apps/staff, packages/staff-auth)

1. **`packages/staff-auth/src/api/auth.ts`**:
   - `staffLogin(email, password)` (rename param).
   - Add `staffForgotPassword(email)` and `staffResetPassword(token, newPassword)`.

2. **`packages/staff-auth/src/StaffLoginForm.tsx`**:
   - Replace the phone input with an email input
     (`type="email"`, `autoComplete="username"`, `inputMode="email"`).
   - Add "שכחתי סיסמה" link below the submit button that switches the form
     to a `ForgotPasswordForm` view (in-place; no router needed).
   - Hebrew copy follows the existing card style.

3. **New `ForgotPasswordForm`** (in `packages/staff-auth`):
   - One email field + submit.
   - On submit: call `staffForgotPassword`, show a generic "אם המייל קיים
     אצלנו, שלחנו אליו קישור לאיפוס סיסמה" message and a "חזרה לכניסה" link.
   - No enumeration: same message on success/error/rate-limit.

4. **New `ResetPasswordForm`** (in `packages/staff-auth`):
   - Detects `?reset_token=...` in `window.location.search` on mount.
   - Two fields: new password + confirm.
   - On submit: call `staffResetPassword`. On success, strip the param from
     the URL (`history.replaceState`), show "הסיסמה עודכנה. אפשר להתחבר עם
     הסיסמה החדשה.", and render the login form.
   - On `invalid_token`: show "הקישור לא תקף או שפג תוקפו. בקשו קישור חדש
     מהמסך הקודם." with a link back to the forgot form.

5. **`packages/staff-auth/src/staff-session.tsx`**:
   - `signIn(email, password)` signature change.
   - Add a small router-like state machine for the signed-out view:
     `signed-out-login | signed-out-forgot | signed-out-reset`. The reset
     state is entered automatically when the URL contains `reset_token`.
   - This keeps both apps (apps/admin and apps/staff) free of the routing
     concern — they continue to render `<StaffLoginForm />` and the form
     internally switches sub-views.

6. **`apps/admin/src/lib/api/staff.ts`** + the admin staff page UI:
   - `CreateStaffInput.email` becomes required in the form when role is
     admin/manager (client-side validation mirrors server).

### Settings audit (per global rule 15)

- **Reset link TTL**: kept as a code constant (30 min). Not exposed — security
  defaults are not a knob the admin should casually tune.
- **STAFF_LOGIN_URL**: env-var, not a runtime setting. Set per deploy.
- **No new user-facing settings.** The forgot-password flow is a security
  utility, not a feature with preferences.

### Observability (per global rule 14)

Namespaced logs on every meaningful branch:

- API: `[auth login]`, `[auth forgot]`, `[auth reset]`, `[staff create]`,
  `[staff update]` (with `{ email, role, byStaffId, reason? }`; never log
  raw passwords or raw tokens).
- Web: `[web auth] login attempt`, `[web auth] forgot requested`,
  `[web auth] reset submit`, `[web auth] reset success`, plus the existing
  `[web auth] hydrating / signed in / signed out`.

### Security (per global rule 13)

- Raw reset tokens never logged, never stored — only their SHA-256 hash.
- Token entropy: 256 bits (32 random bytes), base64url.
- TTL 30 minutes; single-use; consumed atomically.
- After a successful reset, ALL outstanding reset tokens for the user are
  invalidated. (Stops a leaked-but-unused token from being weaponized after
  the legitimate user beat the attacker to it.)
- No enumeration on `/auth/forgot-password` or `/auth/login`.
- Email lookup is case-insensitive (`lower(email)`); the unique index uses
  the same expression.
- `STAFF_LOGIN_URL` must be on a trusted origin; reset emails always link
  to it, never to a value the requester supplied.
- Rate-limit on `/auth/forgot-password`: cooldown per staffId
  (60s), and a per-email window cap to absorb mistyped emails without
  flooding.

### Testing (per global rule 18)

Unit:

- `packages/db/src/staff-password-resets.test.ts`: mint + consume happy
  path, second consume returns `invalid_or_consumed`, expired token
  returns `expired`, invalidate-others burns siblings.
- `packages/db/src/accounts.test.ts`: extend with `getStaffByEmail`
  case-insensitive lookup.

Integration (apps/api):

- `auth.test.ts` (new): `/auth/login` with valid email succeeds; wrong
  password 401; non-existent email 401; inactive staff 401; case-insensitive
  email match; `/auth/forgot-password` always 200 (with-or-without match);
  `/auth/reset-password` valid token succeeds and new login works; reused
  token fails; expired token fails.
- `staff.test.ts`: create admin without email → 400; create cashier without
  email → 201; duplicate email → 409.

Manual smoke:

- `pnpm dev` → open admin app → log in with seeded admin email + password →
  log out → click "שכחתי סיסמה" → check console email provider stdout for
  the reset URL → open the URL → submit a new password → log in with new
  password.

## Open questions

None blocking. The dev `STAFF_LOGIN_URL` default needs to match whichever
vite port the staff app uses; I'll read `apps/staff/vite.config.ts` when
wiring the env default.

## Rollout

1. Migration (additive: new table + new partial unique index; no destructive
   change to existing rows or columns).
2. Backend (no new endpoint paths overlap with existing ones).
3. Frontend (login form swap is the user-visible change).
4. Backfill: any existing admin row with `email = null` needs an email
   before they can log in. Re-run seed-admin with `SEED_ADMIN_EMAIL` set
   for the seeded admin; any other admin/manager can update their row via
   the staff routes while still signed in.
