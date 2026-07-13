# Wave 2 — admin-editable UI content system — 2026-07-13

Goal: let Yanay (product owner, admin) self-edit UI copy across the apps so
wording changes stop being code changes. Yoav chose **comprehensive** coverage
(every UI string ultimately editable) over a curated set. Build the system so it
scales to that, and reach "comprehensive" surface-by-surface rather than in one
big-bang extraction.

Grounded in recon (2026-07-13): the editable email-copy pattern in `card_settings`
is the precedent; all three apps share `apiRequest` from `@memesh/web-shared`,
use plain hooks + a session provider, and hardcode ~200-300 Hebrew strings; apps
import `packages/*` but never each other.

## Architecture (rule 20 — boundaries first)

Three layers, each a single source of truth for its concern:

1. **Registry (code, SSOT of *what's editable* + defaults).** A new pure-TS
   package `@memesh/content`. One entry per string:
   ```ts
   { key: 'customer.cancel.rule',        // stable unique id
     group: 'customer_area',             // admin grouping
     label: 'כלל ביטול',                  // admin field label (He)
     help: 'הטקסט שמסביר עד מתי אפשר לבטל', // admin hint
     default: 'אפשר לבטל עד {{hours}} שעות לפני המועד', // He fallback
     kind: 'short' | 'long',             // input widget
     placeholders: ['hours'] }           // allowed {{vars}}, validated
   ```
   Zero deps, so the Node API, the DB layer, and all three browser apps import
   the same list. This is the SSOT for defaults + metadata. Adding an editable
   string later = one registry line, no migration.

2. **Overrides (DB, stores *only what changed*).** New `content_overrides` table
   in `@memesh/db`: `(key text pk, value text not null, updated_at, updated_by)`.
   Only keys Yanay edited have rows; everything else uses the registry default.
   First generic key-value table in the schema (all others are typed singletons)
   — appropriate here because the key space is open and code-owned.

3. **Delivery + consumption.**
   - API `GET /content` (public, short cache) → the **merged** map
     `{ key: override ?? default }`, computed from the bundled registry + one
     small overrides query. Public is fine — these strings are already visible
     in the app.
   - A `ContentProvider` + `useContent()` hook (React, in `@memesh/content/react`
     so the Node API never imports React). Fetches `/content` once on app boot
     (beside the existing session hydration) and exposes
     `t(key, vars?) → override ?? registryDefault`, interpolating `{{vars}}`.
   - **Fail-safe (rule 13):** if a key is missing from the fetched map or the
     fetch failed, `t` returns the registry default that's **bundled in the app**.
     A blank field or a dead `/content` endpoint therefore *never* shows an empty
     label. Blank is impossible to store (see admin rules).
   - **Rendered as plain text only.** React's default escaping; never
     `dangerouslySetInnerHTML`. Long text with line breaks uses
     `white-space: pre-wrap`, not HTML. Mirrors the email copy's HTML-escaping.

4. **Admin editor.** A new "תוכן" section in the admin Settings page
   (`apps/admin/src/admin/settings/Settings.tsx` `SECTIONS`), rendered *from the
   registry*, grouped by `group`, with a search box (comprehensive = many
   fields). Each field: current value (short→`TextField`, long→`TextAreaField`
   from `shared.tsx`), the default shown beneath, and a per-field
   "אפס לברירת מחדל" (reset). Save (`SaveBar` + a `useSectionSave`-style flow)
   `PATCH /admin/content` writes only changed keys; a blank submit is a reset,
   never an empty store.

### SSOT wins folded in
- The #3a cancel/reschedule copy is a template (`…עד {{hours}} שעות…`); the app
  passes the **actual** configured `cancellationWindowHours` from `round_settings`,
  so the wording is editable but the number stays single-sourced.

## Rollout (phased — reaches "comprehensive" safely)

- **Phase 1 (this Wave 2 start):** build the whole system core (registry package,
  `content_overrides` + DB helpers, `/content` + `/admin/content` routes,
  `ContentProvider`/`useContent`, admin "תוכן" editor). Seed the registry with
  the **אזור אישי** strings and migrate `apps/customer/src/customer/CustomerApp.tsx`
  to `t()`. This is the surface Yanay most wants and it carries #3a.
- **Phase 2:** staff page strings (`apps/staff`), extend registry, migrate.
- **Phase 3:** remaining customer screens (checkout, gift, waitlist) + any admin
  operator copy. Email copy already editable in `card_settings` — leave as is or
  fold in later for one surface.

Each phase ships independently. Big-bang "extract every string at once" is
explicitly rejected: high regression risk, a sprawling editor no one has vetted,
and no early proof the model is right.

## Security (rule 13)
- `PATCH /admin/content` is admin-gated (Yanay is admin). Key must exist in the
  registry (reject unknown), value length-limited per `kind`, `{{placeholders}}`
  validated against the entry's declared list (mirrors `validateEmailOtpTemplate`).
- Plain-text rendering only — no script injection from admin-entered copy.
- Blank → reset, never stored empty (fail-safe defaults always present).
- `GET /content` public but read-only and non-sensitive.

## Observability (rule 14)
- `[content edit]` logs the diff on save; `[content serve]` logs cache hit/miss
  and override count. Client logs `[content boot]` with fetched/keys on load.

## Settings (rule 15)
- The content editor *is* a settings surface. No new hardcoded copy after Phase 1
  for migrated screens — that's the point. Non-migrated screens stay hardcoded
  until their phase; that's a known, logged boundary, not a silent gap.

## Testing (rule 18)
- Registry integrity: unique keys, non-empty defaults, every `{{var}}` in a
  default is declared in `placeholders` (and vice versa).
- `interpolate()` unit tests (missing var, extra var, no vars).
- `content_overrides` DB: upsert, reset-to-default (delete row), reject unknown
  key, length + placeholder validation, empty-diff no-op.
- API: `GET /content` merged shape; `PATCH /admin/content` admin-gate + validation
  error mapping.
- `useContent` fallback: missing key and failed fetch both return the bundled
  default (the fail-safe is the whole point — test it).

## Deploy (rule 19)
- Adds one migration (`content_overrides`) — deploy must migrate before the API
  serves. Own branch → PR into `main` → CI → merge deploys. Nothing by hand.

## Alternatives rejected
- **Typed columns per string (like `card_settings`):** a migration per new string,
  column sprawl; unworkable for comprehensive. Rejected.
- **Full i18n library (react-i18next):** heavyweight, built for multi-locale we
  don't have (100% Hebrew), and still needs an admin editor on top. Rejected.
- **Registry in `web-shared`:** it's browser-oriented (Vite env), not cleanly
  importable by the Node API. Hence the standalone `@memesh/content`.

## Open questions
1. Propagation: content loads once on app boot, so an edit shows on the user's
   next app load (not live to an open session). Fine for copy — confirm.
2. Phase-1 surface = אזור אישי (CustomerApp). Confirm before extraction.
