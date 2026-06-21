# Plan — Staff POS refactor to fix laggy typing

**Date:** 2026-06-22
**Branch:** feat/phase1-secure-core (active)
**Author:** Yoav + Claude
**Status:** draft — awaiting approval

---

## Goal

Fix the symptom Yoav reported: in the staff portal, typing in any text box feels stuck/laggy, as if the input pauses after every letter. Restore smooth, native input behavior on every screen of the POS (search, new customer, sell, scan-by-serial, PIN entry).

Underlying intent: remove the structural React anti-pattern that causes the lag, so future inputs added to the POS do not inherit the same problem.

## Root cause (verified, not guessed)

`apps/staff/src/pos/PosApp.tsx` declares every screen and every input-bearing subcomponent **inside** the body of `PosApp`:

- `BackBar` — line 787
- `Home` — line 809
- `Stat` — line 957
- `Search` — line 966 (owns the search `<input>`)
- `Customer` — line 1042
- `NewCustomer` — line 1310 (owns first/last/phone/email inputs via `NewCustomerField`)
- `NewCustomerField` — line 1437 (the actual `<input>`)
- `NewCustomerExtras` — line 1514 (children dob/name inputs, source select)
- `Sell` — line 1726 (owns receipt-number input)
- `Scan` — line 1928 (owns serial-input field)

Combined with ~55 `useState` hooks declared in `PosApp` itself, every keystroke:

1. Triggers a setter in `PosApp` (`setQuery`, `setNewFirst`, `setSerialInput`, …).
2. Re-renders `PosApp`, which recreates every inner `function Foo() {}` as a **new function reference**.
3. React's reconciler sees a different component *type* and **unmounts + remounts** the entire subtree.
4. The `<input>` is destroyed and recreated; focus is lost; IME composition (Hebrew, autocomplete) is wiped; layout/style work runs again.

This is the canonical "do not define components inside other components" anti-pattern. It also silently breaks browser autofill, mobile keyboard suggestions, and IME composition for Hebrew typing — symptoms Yoav may not have isolated yet but which are caused by the same bug.

`SellerPinModal` (line 2220) and `SelfPinModal` (line 2327) are already at module scope and are **not** affected — confirming the diagnosis.

## Non-goals (deliberate cuts)

1. **No business-logic changes.** State shape, API calls, validation rules, pricing math, punch/scan/sell logic — all preserved byte-for-byte.
2. **No visual redesign.** Inline styles and JSX structure carry over unchanged.
3. **No state management library introduction** (no Zustand/Redux/Jotai). The fix is structural extraction, not a state refactor.
4. **No new features.** This is a bug fix dressed as a refactor.
5. **No expansion to other apps** (`apps/admin`, `apps/customer`) in this PR. If they have the same anti-pattern, that's a separate audit.

## Alternatives considered

### Option A — Surgical fix: lift only the input-bearing subcomponent (`NewCustomerField`)
Move `NewCustomerField` to module scope; leave everything else alone. **Smallest diff. Rejected** because the lag will reappear on every other screen with an input (`Search`, `Sell` receipt field, `Scan` serial input) and any input added later. We have already paid the diagnosis cost; not finishing the fix is false economy.

### Option B — Wrap each input-heavy screen in its own real component that owns its own input state
Smaller diff than full extraction. **Rejected** because `Search`, `NewCustomer`, etc. depend on parent state (selected customer, pricing, form rules, sell controls) and trying to give each one local state plus a sync mechanism would re-create the bug in a more confusing form.

### Option C — Full extraction: lift all screens to module scope, pass state via props (CHOSEN) ✓
Move `BackBar`, `Stat`, `Home`, `Search`, `Customer`, `NewCustomer`, `NewCustomerField`, `NewCustomerExtras`, `Sell`, `Scan` out of `PosApp` into top-level components in the same file (or split files). Each receives the state/handlers it needs as typed props. `PosApp` becomes a thin orchestrator that holds state and renders the right screen.

Pros:
- Permanently kills the unmount-on-keystroke bug across all current and future POS inputs.
- File becomes navigable; right now `PosApp` is ~1,950 lines in one function.
- Matches Yoav's rule 2 (clean, ordered code). The current shape violates it.

Cons:
- Larger diff (~1,500 lines moved + new prop interfaces).
- Risk of a missed prop or stale-closure regression in a screen that has no test coverage (see Testing section).

## Chosen approach — incremental, bisectable

Execute in dependency order, leaves first, **one commit per screen**. After each commit: `pnpm -F @memesh/staff typecheck && pnpm -F @memesh/staff test` must pass. If a commit goes red, revert *that* commit only.

Extraction order:

1. **Pure leaves with no state dependency** — `Stat`, `BackBar`. Trivial; warm-up.
2. **`NewCustomerField`** — the actual input element causing the visible lag in the New Customer form. Earliest big win.
3. **`NewCustomerExtras`** — depends on `NewCustomerField` shape being final.
4. **`Scan`** — already has its own internal state (line 1942-1950); extraction is mostly a prop-wiring exercise. Owns the serial-input field.
5. **`Sell`** — owns the receipt-number input. Has fewer parent dependencies than `NewCustomer`.
6. **`Search`** — owns the search input. Touches `searchResults`/`searchLoading`/`searchError` state on parent.
7. **`NewCustomer`** — largest screen; depends on already-extracted `NewCustomerField` and `NewCustomerExtras`.
8. **`Customer`** — the customer-detail screen; complex but few inputs.
9. **`Home`** — wrapper, mostly nav. Last.

Where it makes sense, screens move into sibling files (`apps/staff/src/pos/screens/Search.tsx`, etc.) for navigability, but only after extraction — file split is a separate, mechanical step after correctness is proven.

## Known-risky pieces (called out for extra care)

1. **Refs shared across the parent/child boundary** — `punchStatusTimer` (line 343), `inputRef` (line 2232 — already in a top-level component, no issue). Refs must be passed as the ref *object*, never as `.current` value.
2. **Helper closures with side effects** — `flashStatus` (line 346), `closeRefundModal` (line 358), `resetNewCustomerForm` (line 392), `switchCashier` (line 589), `sellNewForSelectedCustomer` (line 596), `openPunch` (line 678), `openCustomer` (line 716). Each captures parent state. They stay in `PosApp` and are passed down as props. None should be re-declared inside extracted screens.
3. **`useEffect`s in the parent that respond to screen state** (lines 605, 638, 666) — must stay in `PosApp` because they coordinate cross-screen state (e.g. fetching pricing once at mount, syncing punch status). Do not move them with the screens.
4. **`Scan` has its own `useEffect` lifecycle** (camera attach/detach, line 1952). Hooks travel with the component; verify the camera still attaches/detaches correctly after extraction.
5. **Stale closures in `setTimeout`/`Promise.then` callbacks** — sweep each extracted screen for callbacks that read parent state. If any read state via a stale prop, convert to a ref or pass the setter and call it.

## Security

Zero change to attack surface. No new routes, no new inputs, no new permissions, no new external integrations. The refactor is purely structural.

Per rule 13: revalidated that the existing input validation (phone format, email format, child DOB) remains inside `handleSubmit` paths that are *not* moving — only the rendering of the input fields moves. Validation logic stays in `PosApp`.

## Observability

Per rule 14: the staff POS currently has **no diagnostic logs** worth speaking of. This refactor adds namespaced render logs to each extracted screen as the bare minimum, so the next time something silently breaks Yoav can paste the console:

```ts
console.info('[staff-pos screen]', 'render', { screen: 'Search', query, resultsCount: searchResults.length });
console.info('[staff-pos screen]', 'render', { screen: 'NewCustomer', step: 'extras-' + (newExtrasOpen ? 'open' : 'closed') });
```

Logs are added at the top of each extracted component's body. They are deliberately not in `useEffect` (we want them on *every* render so we can see re-render storms, which is the very class of bug this PR fixes).

Out of scope for this PR (flagged for a follow-up): backend log parity, structured fields, log levels via env. The goal here is just "if it breaks, we can see what re-rendered."

## Settings

Per rule 15: no new user-facing settings. The refactor introduces no defaults, no behaviors that need a knob, no visual choices the user might want to flip. Nothing to surface in the admin settings layer.

## Testing

Per rule 18 — **honest gap to call out:**

The staff app currently has **5 tests**, all listed in `apps/staff/package.json`:
- `App-isolation.test.ts` — import graph isolation (does not exercise the POS UI)
- `lib/api/customers.test.ts`, `cards.test.ts`, `punch.test.ts`, `staff.test.ts` — API client wrappers (do not render components)

**There is zero automated coverage of the POS UI itself.** A pure refactor can therefore introduce a silent regression that no test will catch. This is the single largest risk in this plan.

Mitigation:

1. **Manual smoke pass after each commit**, in this order, against the dev server:
   - Type in the search box — confirm focus is held across the full word, Hebrew composition works, no per-letter pause.
   - Open New Customer — type into first/last/phone/email; toggle the extras; add a child; type into child name + dob; confirm Submit still posts the same payload (compare network tab before/after).
   - Open Sell — type into receipt-number; toggle "name on receipt"; confirm Sell still completes.
   - Open Scan — switch to serial entry; type into the serial input; confirm punch still completes.
   - Open Customer detail — confirm cards/entries render unchanged; refund modal still opens and submits.
   - PIN modals — confirm `SellerPinModal` and `SelfPinModal` still focus their input on open (they are already top-level; this is a regression check, not a refactor target).

2. **Add a regression test for the original bug**: a small Node-test that imports `apps/staff/src/pos/PosApp.tsx` source, scans it via regex, and asserts no function/component declaration occurs between `export function PosApp() {` and the matching closing brace. This prevents the anti-pattern from being reintroduced.

3. **A11y + IME smoke** — type in Hebrew (RTL) and verify composition events fire cleanly. The Hebrew composition bug was a likely-but-unverified consequence of the unmount-on-keystroke; this check confirms the fix lands.

4. **Existing test suite runs green** after every commit (`pnpm -F @memesh/staff test`).

If Yoav approves a higher bar, we can add React Testing Library + jsdom and write proper render/interaction tests for each screen. That is a larger lift and a separate decision — flagged here, not assumed.

## Rollback

Each screen is its own commit. If a screen's extraction regresses behavior:

1. Revert that single commit (`git revert <sha>`).
2. The other extractions remain in place; the POS still works.

No DB migration, no API change, no env var — rollback is purely git-revert.

## Open questions for Yoav before execution

1. **File split or single file?** Should the extracted screens move into `apps/staff/src/pos/screens/*.tsx` (cleaner, more files) or stay in `PosApp.tsx` at module scope (smaller diff, one giant file)? Recommendation: stay in `PosApp.tsx` for the bug-fix PR, split files in a follow-up PR so the two concerns are not entangled.
2. **Add render-time `console.info` logs?** They are very useful for diagnosing future re-render storms, but they will show up in prod console too unless gated by `import.meta.env.DEV`. Recommendation: gate on `import.meta.env.DEV` so prod console stays clean.
3. **Regression-guard test?** Worth the ~30 lines to add the source-scan test that prevents the anti-pattern from creeping back in? Recommendation: yes, cheap insurance.
4. **Higher test bar?** Want me to add React Testing Library + jsdom and write real component tests for each extracted screen, or rely on the manual smoke pass and the source-scan guard? Recommendation: rely on manual + source-scan for this PR; defer RTL setup to a separate plan, because adding it well is its own multi-hour task.

## Estimated commits

~10 commits, one per extracted screen + the regression-guard test + (optionally) the file split.

## Done when

- Typing in every input on every POS screen feels native — no per-letter pause, focus held, Hebrew composition intact.
- `pnpm -F @memesh/staff typecheck` clean.
- `pnpm -F @memesh/staff test` green.
- Manual smoke pass complete with no regressions.
- Regression-guard test (if approved) in place.
