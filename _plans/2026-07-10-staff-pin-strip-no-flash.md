# Staff Home: stop the cashier-PIN strip flash

Date: 2026-07-10
Source: Yanay's WhatsApp screenshots, 2026-07-09 21:49 ("מה שמוקף בעיגול מופיע
לשנייה ואז נעלם", "זה בStaff") — the "החלף קופאי" / "ניהול הקוד שלי" buttons
appear for a second on the staff dashboard, then vanish.

## Root cause

`sellControls` initializes from `FALLBACK_SELL_CONTROLS` (fail-closed,
`requireSellerPin: true`), so Home rendered the PIN strip immediately on
mount; when `getPosSellControls()` resolved `false` for this venue the strip
unmounted — the flash.

## Approach

New `sellControlsLoaded` state, set true once the fetch settles (both the ok
and the fallback branch). Home receives
`requireSellerPin={sellControlsLoaded && sellControls.requireSellerPin}`, so
the strip renders only from real data. On a fetch ERROR the strip still shows
(fallback stays fail-closed and `loaded` flips true) — an API blip must not
hide the PIN tools on venues that use them. The sell flow keeps reading the
fallback while loading; fail-closed still guards the till.

## Alternatives rejected

- Defaulting the fallback to `requireSellerPin: false`: silently drops the
  fail-closed guarantee in the sell flow on any API error. No.
- Skeleton/placeholder while loading: over-engineering for two buttons that
  most venues have off.

## Security / Observability / Settings

- Security unchanged: server re-validates the PIN on POST /cards regardless.
- Existing `[web pos sell-controls]` logs already record fetched/fallback.
- No new settings — this is a rendering-correctness fix.

## Testing

`node --test --import tsx`, no React renderer (repo convention), so
`PosApp-pin-strip-no-flash.test.ts` pins the contract as source-structure
guards: the gated prop expression, the gate starting false, and the settle
call sitting after both fetch branches. Suite run: 39 pass, 1 pre-existing
baseline failure (`staff.test.ts` .png import under node --test — known,
unrelated).

## Deploy

Branch `fix/staff-pin-strip-flash` → PR into `main`; standard pipeline deploys
the staff app. Rollback: revert the merge commit.
