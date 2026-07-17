# PayPlus refund cutover — admin manual-cancel override

Date: 2026-07-17
Branch: feat/wave2-staff-content (build here, PR into main via the normal flow)
Owner: Yoav (technical lead) · Product: Yanay

## Goal

Yanay moved the WooCommerce checkout gateway from Grow/Meshulam to **PayPlus**, which
supports programmatic refunds. We want customer self-cancel in the אזור אישי to
trigger an **automatic refund** again. That is a single admin toggle
(`round_settings.manualRefundOnCancel` → false). This plan builds the one thing
that toggle needs to be safe: an admin escape hatch for the pre-swap **Grow tail**.

## Why this is needed (the real problem)

Payment provider lives in WordPress, not in our Node API. Our code refunds via
WooCommerce REST `api_refund: true` (`apps/api/src/lib/wc-rest-client.ts`), which
delegates to whichever gateway processed the order. New PayPlus orders refund
fine. But bookings **paid via Grow before the swap** still carry Grow
transactions; auto-refunding them fails (WooCommerce returns non-2xx → our code
throws → `refund_failed` → HTTP 502, seat kept).

Both cancel routes read the same global `manualRefundOnCancel`:
- customer: `apps/api/src/routes/rounds-booking.ts:612`
- admin/staff: `apps/api/src/routes/staff-rounds.ts:438`

So once the global flag is false, a Grow-era booking can't be cleared by anyone
through the app — staff hit the same 502. A single global boolean can't express
"auto for PayPlus, manual-capable for Grow" at once. The fix is a **per-booking
admin manual-refund override**.

Decision (2026-07-17): Grow tail = **option 1** (flip to auto, handle Grow
bookings manually). WC_API_URL confirmed set in Vercel prod.

## Scope

In scope:
- Admin cancel route accepts optional `manualRefund: true` and, when set, forces
  the manual path regardless of the global setting; returns `refundPending`.
- Admin cancel route fires the existing cancellation emails on `refundPending`
  (staff alert + customer confirmation) — same invariant as the customer route.
- Admin UI (both callers) offers a "cancel + refund by hand" action **only when
  an auto-refund attempt returns `refund_failed`** — no permanent button clutter.
- Tests for the route and the DB flag pass-through.

Out of scope (deliberately):
- The global flip itself (Yoav does it in admin after verifying one real PayPlus
  refund end-to-end — needs a real card, can't be done from code).
- Per-order gateway detection (option 3). The manual override covers the tail
  without a WC lookup per cancel.
- Any change to `cancelBooking` (DB layer) — it already accepts `manualRefund`
  and is tested (`packages/db/src/rounds-cancel.test.ts:89`).

## Architecture / SSOT

- Money-safety invariant unchanged: auto mode stays fail-closed (seat released
  only on confirmed refund). The override is an explicit operator action that
  frees the seat and hands the refund to staff — the exact semantics the interim
  manual mode already has, now reachable per-booking.
- "manual refund pending → notify" becomes a single rule enforced in both routes
  (customer already does it; admin now matches).
- Boundary respected: UI → route → `cancelBooking` dep injection; the DB layer
  never learns about PayPlus/Grow.

## Changes

1. `apps/api/src/lib/api/round-participants.ts` (admin client): `removeBooking`
   gains an optional `{ manualRefund?: boolean }`; response type gains
   `refundPending: boolean`.
2. `apps/api/src/routes/staff-rounds.ts`: parse optional body
   `{ manualRefund?: boolean }`; `useManual = body.manualRefund === true ||
   settings.manualRefundOnCancel`; pass to `cancelBooking`; on `refundPending`
   call `fireCancellationEmails`; add `refundPending` to the response.
3. `apps/admin/src/admin/RoundAttendeesPanel.tsx` and
   `apps/admin/src/admin/Tickets.tsx`: on a `refund_failed` result, surface an
   inline manual-cancel affordance that re-calls with `{ manualRefund: true }`,
   with clear Hebrew copy; success message states the refund must be done by hand.

## Security

- Route stays `requireRoleHook('admin')` — only admins can move money / force a
  manual cancel. No new surface.
- The override frees a seat without confirmed money back **by explicit admin
  choice**; it's logged (`[staff rounds remove]`) with `manualRefund` + booking id
  so every use is auditable.

## Observability

- Log the effective mode on the admin cancel: `manualRefund` (requested vs
  effective), `refundPending`, booking id, staff id.
- Admin UI already logs `[admin round panel] remove` / `[web tickets] remove`;
  extend with the manual-fallback branch.

## Testing

- API route test: `manualRefund: true` forces manual even when global is auto
  (result `refundPending: true`, refund fn not called, seat freed); absent flag
  follows the global setting; auto path still fail-closed on `refund_failed`.
- DB pass-through already covered by `rounds-cancel.test.ts`.
- Run `packages/db` + `apps/api` suites; confirm no regression in the existing
  cancel tests.

## Deploy

- Build on `feat/wave2-staff-content`. PR into `main` (production-tracking) via
  the normal flow — no direct push, no manual promote.
- After merge + deploy: Yoav verifies one real PayPlus refund, then flips
  `manualRefundOnCancel` to false in admin. Rollback = flip it back to true
  (returns to full manual mode), no code redeploy needed.

## Open questions

- Should the staff alert email fire when the admin themselves triggered the
  manual cancel (they already know)? Decision: yes — it's the durable to-do so
  the Grow refund isn't forgotten, and it carries the WC order number.
