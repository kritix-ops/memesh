# Card Settings — admin-editable defaults for new punch cards

**Status:** approved 2026-06-19 (Yoav).
**Author:** Claude (Opus 4.7) + Yoav.

## Goal

Move the three hardcoded punch-card defaults (price, validity, total entries) plus the marketing pitch line out of code constants and into an admin-editable settings screen. Brother (product owner) and Yoav must be able to change pricing without a code deploy.

## Constraints

- Single-tenant for now (one row of settings, no `account_id`). Schema designed so adding `accountId` later is a column add + index, no rewrite.
- Backward-compatible: rolling out the migration must not break existing cards. Existing cards keep their original `total_entries` and `expires_at` values forever — the settings only affect cards created **after** the change.
- Admin-only edit. Manager and cashier cannot see the screen and cannot hit the write endpoint.
- Server is the source of truth. POS frontend reads price + pitch from the API, not from a constant.

## Decisions locked with Yoav (2026-06-19)

| Question | Answer |
|---|---|
| Knobs in scope | Price (₪), Validity (days), Total entries, Display pitch label |
| Who can edit | Admin only |
| Apply to existing cards? | No — new cards only |
| Nav placement | New 'הגדרות' tab at the bottom of admin nav |

## Out of scope (explicit)

- Multi-tenant per-account settings.
- Recording `price_paid_shekels` on the `punch_cards` row (useful for revenue reports — separate task).
- SMS provider / branding / opening hours settings (own feature, lands in same 'הגדרות' tab later).
- Changing the price label structure (the line stays "X · תקף לשנה" style; only the text is editable).
- Currency: shekels only.

## Approach

### Database (packages/db)

**New table:** `card_settings`. A singleton — exactly one row, enforced by a unique constraint on a fixed boolean column.

```sql
CREATE TABLE card_settings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton           boolean NOT NULL DEFAULT true UNIQUE,
  price_shekels       integer NOT NULL DEFAULT 320,
  validity_days       integer NOT NULL DEFAULT 365,
  total_entries       integer NOT NULL DEFAULT 12,
  pitch_label         text    NOT NULL DEFAULT 'משלמים על 10, מקבלים 12 · תקף לשנה',
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES staff(id)
);
INSERT INTO card_settings DEFAULT VALUES;  -- seed the row
```

**Why the `singleton boolean UNIQUE` trick:** Postgres has no clean "exactly one row" constraint. A unique column with a default value enforces it at the DB level. Cheap, standard pattern.

**New schema file:** `packages/db/src/schema/card-settings.ts`.

**New module:** `packages/db/src/card-settings.ts` with:
- `getCardSettings(db)` → reads the singleton row.
- `updateCardSettings(db, input, staffId)` → validates ranges, updates, logs a staff action, returns new row.

Validation ranges (server-side, do not trust client):
- `priceShekels`: integer 0 ≤ x ≤ 10000.
- `validityDays`: integer 1 ≤ x ≤ 3650.
- `totalEntries`: integer 1 ≤ x ≤ 100.
- `pitchLabel`: string 1–200 chars, trimmed.

**Wire `createPunchCard`** ([packages/db/src/cards.ts:111](packages/db/src/cards.ts#L111)) to read from `card_settings` instead of the constants. The `input.totalEntries` override still wins (preserves existing behavior).

**Staff action audit:** add `update_card_settings` to the staff actions log. Action summary should include a diff: e.g. `"עדכון הגדרות כרטיסייה · מחיר 320→340"`.

### API (apps/api)

**New routes** in `apps/api/src/routes/admin.ts` (or a new `card-settings.ts` plugin — leaning toward the latter for clarity):

- `GET /admin/card-settings` — `requireRoleHook('admin')`. Returns the current row.
- `PUT /admin/card-settings` — `requireRoleHook('admin')`. Validates body with zod, calls `updateCardSettings`, returns updated row.

Also expose a **public read** for the POS sell screen, since cashiers need the price + pitch to display:
- `GET /pos/card-pricing` — `requireRoleHook('cashier', 'manager', 'admin')`. Returns only `{ priceShekels, pitchLabel }` (not the validity/entries — those are server-internal).

### Frontend (apps/web)

**New API client:** `apps/web/src/lib/api/card-settings.ts` with `getCardSettings`, `updateCardSettings`, `getCardPricing`.

**Admin nav:** add `{ key: 'settings', label: 'הגדרות' }` at the bottom of `NAV` in [apps/web/src/admin/AdminApp.tsx:82](apps/web/src/admin/AdminApp.tsx#L82). Gate the nav button so non-admins don't see it (`if role !== 'admin') filter out`).

**New admin screen:** `Settings()` component inside `AdminApp.tsx` (consistent with how `Cards()`, `Customers()`, `Staff()` are colocated). Layout:

```
הגדרות כרטיסייה
─────────────────────────────────────
מחיר (₪)             [320      ]
תוקף כרטיסייה (ימים) [365      ]
כניסות בכרטיסייה     [12       ]
טקסט שיווקי בקופה    [משלמים על 10, מקבלים 12 · תקף לשנה]
                     נראה ללקוח במסך מכירה

[ביטול]                              [שמור]
```

Validation mirrors the server. Save shows inline success ("הגדרות נשמרו") + Toast. Save button disabled while no fields are dirty.

**POS sell screen** ([apps/web/src/pos/PosApp.tsx:1275](apps/web/src/pos/PosApp.tsx#L1275)): replace the `CARD_PRICE = 320` constant and the hardcoded pitch line with values fetched from `GET /pos/card-pricing` on mount. Show a small skeleton while loading. If the fetch fails, fall back to the constants and warn in console (do **not** block the cashier — sale must still work offline-ish).

### Observability (rule 14)

- `[card-settings get]` on every read with no values logged (settings can change so often it's fine to log access, not values).
- `[card-settings update]` with `{ staffId, diff: {field: [old, new]} }`. PII-free.
- `[web admin settings] save` on click with the diff.
- `[web pos pricing] fetched` on POS load with `{ priceShekels }`.

### Security (rule 13)

- Admin-only on write. Manager and cashier cannot edit. Enforced server-side via `requireRoleHook('admin')` — frontend nav hiding is UX only, not a security boundary.
- Zod-validated ranges on the server. No raw SQL composition — Drizzle parameterizes everything.
- `updated_by` recorded on every change. Full diff written to `staff_actions` for audit.
- No secrets leave the server. Settings are operational config, not credentials.
- Rate limit: inherit the global 100/min, no special limit needed (admin endpoint, low traffic).

### Tests (rule 18)

**packages/db/src/card-settings.test.ts** (new):
- Returns default row if none exists (idempotent on first call).
- Update persists each field.
- Validation rejects out-of-range (price 99999, days 0, entries 101, empty pitch).
- Staff action logged with diff.

**packages/db/src/cards.test.ts** (update existing):
- `createPunchCard` with no `totalEntries` override now reads from settings — verify by setting `totalEntries=8` in settings and asserting the new card has 8.
- `createPunchCard` with explicit `totalEntries=15` still wins over settings.
- `expiresAt` reflects settings `validityDays`.

**apps/api integration tests** if there's a pattern (check existing): GET and PUT happy path + admin-only enforcement (cashier gets 403).

## Migration plan

1. Generate Drizzle migration: `pnpm drizzle-kit generate`.
2. Hand-edit to include the `INSERT INTO card_settings DEFAULT VALUES;` seed.
3. Apply locally, verify default row exists.
4. Roll out: migration → API → frontend, in that order. Each step is backward-compatible (API falls back to constants if `card_settings` table is missing — actually, no, simpler: just deploy migration first).

## Settings audit (rule 15)

This **is** the settings audit for this feature — we're explicitly building the settings surface. Future features (SMS provider config, opening hours, branding colors) should land in the same 'הגדרות' tab as additional sub-screens. The `Settings()` component should be structured to take sub-sections from day one (start with one: "כרטיסיות"; leave room for "SMS", "מיתוג", "שעות פעילות").

## Cost (rule 8)

Zero — no new third-party services. One new tiny Postgres table, four new endpoints, one new screen.

## Open questions / things to flag

- Should the price change retroactively affect cards already in the cart but not yet confirmed? No — `POST /cards` reads the current price at the moment of creation. Cashier sees current price on the sell screen, so this is fine.
- Should we add a `priceShekelsAtSale` column to `punch_cards` so revenue reports know what was charged? **Recommended but out of scope for this PR.** File as a follow-up.
- Should staff actions show old → new in the admin action log UI? Yes, the summary already does. The existing log view in AdminApp will render it as text without changes.

## File-by-file deliverables

1. `packages/db/src/schema/card-settings.ts` — new schema.
2. `packages/db/src/schema/index.ts` — export.
3. `packages/db/migrations/0001_card_settings.sql` — generated + seed insert.
4. `packages/db/src/card-settings.ts` — get + update functions.
5. `packages/db/src/card-settings.test.ts` — unit tests.
6. `packages/db/src/cards.ts` — read settings in `createPunchCard`.
7. `packages/db/src/cards.test.ts` — assert settings-driven creation.
8. `packages/db/src/index.ts` — re-export new module.
9. `apps/api/src/routes/card-settings.ts` — new plugin.
10. `apps/api/src/server.ts` (or wherever routes register) — register plugin.
11. `apps/web/src/lib/api/card-settings.ts` — fetch client.
12. `apps/web/src/admin/AdminApp.tsx` — nav entry + `Settings()` component.
13. `apps/web/src/pos/PosApp.tsx` — fetch pricing on mount, drop `CARD_PRICE` constant.
