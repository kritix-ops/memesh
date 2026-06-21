# Remove companions; add multi-entry-per-scan picker

## Goal

Replace the per-punch "companions" concept with a per-scan "how many entries to consume on this scan" picker bounded by the card's remaining entries. The cashier can now consume N entries in a single scan (a mother of three kids picks 3 once, instead of scanning her card three times in a row).

## Drivers

- Real-world flow today forces the cashier to scan repeatedly for groups of children belonging to the same cardholder. The mother + companions framing was modelling the wrong invariant — what the cardholder actually needs to control is *how many entries to deduct right now*.
- The `companionCount` column on `punch_card_entries` was always metadata (one punch always consumed one entry). The picker the cashier saw promised something the data model did not deliver. Removing the abstraction lines the UX up with the data.

## Out of scope

- A per-shift "max entries per scan" admin cap. Not requested. The natural bound (remaining entries on the card) is enough. Easy to add later as a single setting if fraud risk surfaces.
- Reporting changes beyond column rename. The entries report keeps the same row count semantics (one row per scan event); column "מלווים" becomes "כניסות בסריקה".

## Decisions

- **API field**: `entries` (request body on `POST /punch`). Server defaults to 1 when omitted. Range: `1 ≤ entries ≤ remaining` on the card at punch time.
- **DB column rename**: `punch_card_entries.companion_count` → `entries_consumed`. Same column, same default (1), repurposed semantics (it now actually drives the decrement).
- **Settings drops**: `card_settings.min_companions`, `max_companions`. Both fields, both Hebrew labels, both validation rules, both error codes (`min_companions_out_of_range`, `max_companions_out_of_range`, `companion_range_invalid`), the `/pos/companion-limits` route, and the admin UI section's two fields all go.
- **Punch failure reason rename**: `companions_out_of_range` → `entries_out_of_range`. HTTP 400 on either old or new shape — old shape removed.
- **Per-scan decrement**: `usedEntries += entries` (was `+= 1`). Same idempotency semantics (a replay returns the prior card state, the new `entries` value on the replay request is ignored — the original scan already happened).
- **Exhaustion**: `usedEntries >= totalEntries` after the bump deactivates the card. Same as today, just generalized.
- **No new settings knobs**. The "כללי כרטיסיה" section keeps the lockout + grace fields.

## Frontend UX

- **Staff punch modal** (`PunchConfirmModal`): the two companion stepper buttons stay, but the label flips to "כמה כניסות לנקב?", the count caps at `remaining` (not the old settings-driven max), and the unit text under the number reads "כניסה אחת" / "N כניסות". Hint underneath: "נותרו N מתוך M".
- **Customer-detail punch button**: opens the same modal but without preview. Defaults to 1, max = active card's `totalEntries - usedEntries`.
- **Scan flow**: same modal, max = `preview.card.totalEntries - preview.card.usedEntries`.
- **Admin settings → "כללי כרטיסייה"**: two fields removed, two left (lockout, grace).
- **Admin reports → Entries**: column header "מלווים" → "כניסות", CSV header updated, no row-shape change.
- **Admin app and refund modal**: "מלווה אחד / N מלווים" labels → "כניסה אחת / N כניסות" wherever an entry is summarised.

## Observability

- Existing `[web punch] submit { companions }` log → `[web punch] submit { entries }`.
- Existing `[web scan] punch submit { companions }` → `{ entries }`.
- Server-side: `result.reason = 'entries_out_of_range'` surfaces in API logs with the limit hit (`allowedRange: { min: 1, max: <remaining> }`).
- The staff modal logs the picker state on open + every step.

## Security

- Server is still the source of truth: validates `entries ≥ 1`, `entries ≤ (totalEntries - usedEntries)`, runs inside the same `SELECT ... FOR UPDATE` transaction so two concurrent scans can't co-operatively over-draw the card.
- Idempotency unchanged: same key + same card → replay (returns prior state, no second decrement).
- No new attack surface — fewer endpoints (the `/pos/companion-limits` route goes away).

## Tests

- DB: replace the two "rejects companions below/above" tests with three "rejects entries < 1 / > remaining / decrements by N correctly" tests. Update the existing punch happy-path test to assert `usedEntries == 2` when `entries: 2` was passed.
- DB: drop the "min companions > max companions cross-field" test, the "accepts paired min+max" test, and the FIELD_LABELS check for the dropped settings.
- API client (staff): rename `companions` → `entries` in the two existing punch.test.ts cases plus the response shape assertions.
- Cards fixture (staff + admin cards.test.ts): rename `companionCount: 2` → `entriesConsumed: 2` in the mock response body.
- Admin entries report: no UI test exists today; column rename verified by typecheck.

## Migration

Migration `0010_remove_companions.sql`:
```sql
ALTER TABLE "card_settings" DROP COLUMN "min_companions";
ALTER TABLE "card_settings" DROP COLUMN "max_companions";
ALTER TABLE "punch_card_entries" RENAME COLUMN "companion_count" TO "entries_consumed";
```

This is a destructive schema change. Safe here because the project is pre-launch (Phase 1, no production rows of real customer traffic). After ship the next `drizzle-kit generate` will diff cleanly against the new snapshot.

## Settings audit (rule 15)

- Removed: `minCompanions`, `maxCompanions` (and the entire "מלווים" pair in the UI).
- Considered + rejected: a `maxEntriesPerScan` ceiling. Not asked for, and the natural bound (remaining on the card) covers the real risk of "cashier punches the whole card by accident" via the inline hint. Add later only if fraud data justifies it.
- Existing settings unchanged: `sameDayLockoutMinutes`, `gracePeriodDays` still live in the same section.

## Open questions

None blocking. The brief copy in `memesh-brief-v3.md` will be touched separately when we next sweep the docs.
