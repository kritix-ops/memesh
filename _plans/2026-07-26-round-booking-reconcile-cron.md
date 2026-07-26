# Round-booking reconciliation cron (webhook-outage safety net)

Date: 2026-07-26
Status: built + tested locally, awaiting deploy approval

## Why

On 2026-07-23 ~15:36 Israel time, WooCommerce order-webhook #2's Secret field was
blanked in WP admin. Every order webhook then failed HMAC at the API (401), so no
paid **round** booking was minted. Paid holds expired in 15 min and became invisible
to staff. It ran silently for 3 days; 40+ paying customers had no seat. It recurred
during peak hours on 2026-07-26.

Root cause is not the secret alone — it's that the **round-mint path had no backstop**.
An hourly reconciliation cron already exists (`/cron/wc-reconcile`) but it only heals
**cards** (`processWcOrderWebhook`) and only fetches `status=completed`. Round tickets
sit in `processing` and were never reconciled. A single blanked field took down paid
rounds with zero safety net.

## Fix

A parallel round-reconciliation cron, mirroring the card one, running **every minute**:

- `apps/api/src/lib/wc-round-reconciliation.ts` — `reconcileRoundBookings()`. Fetches
  paid orders (injected `listPaidOrdersSince`), runs the same `processRoundOrderWebhook`
  minter per order. Idempotent (mintBooking is a no-op for already-confirmed holds).
- `apps/api/src/routes/cron-rounds-reconcile.ts` — `/cron/rounds-reconcile`. Same
  CRON_SECRET auth as `/cron/wc-reconcile`. Fetches **both** `processing` + `completed`
  (the gap the card path has). Reuses existing env — no new Vercel vars.
- `apps/api/src/app.ts` — register the route.
- `apps/api-deploy/vercel.json` — cron `{ "path": "/cron/rounds-reconcile", "schedule": "* * * * *" }`.

Kept separate from the card reconciliation on purpose (same split as the webhook
processors). SSOT: reuses `processRoundOrderWebhook` / `mintBooking`, no reimplementation.

## Alternatives rejected

- **Just fix the webhook secret.** Necessary but insufficient — it already broke twice
  and the WC admin blanks the field on re-save. No backstop = it recurs.
- **Extend the existing card cron to also do rounds.** Touches the battle-tested card
  path and its completed-only fetch; higher blast radius. Parallel cron is cleaner.
- **Local sweep loop only.** In use now as the emergency bridge, but it's tied to a
  laptop — dies on sleep/reboot. Not "cannot happen again."

## Security

- Same CRON_SECRET Bearer check + timing-safe compare as `/cron/wc-reconcile`.
- Read-only against WC; the only writes are mints through the existing, tested path.
- No new secrets; no PII logged (counts only).

## Observability

- `[cron rounds-reconcile] start / done` with `{ordersScanned, bookingsMinted,
  companionUpgrades, orphanedPaidSeats, durationMs}`.
- `orphaned_paid_seats` logged at WARN — the alarm for a paid ticket we could not seat.

## Testing

- `wc-round-reconciliation.test.ts` — 7 tests: mint-missed, `processing`-status heal,
  idempotent re-run, orphaned-seat count, lookback cutoff, empty, error-propagation.
- Full API suite green (330/330), typecheck clean.

## Deploy

- prod = `main`; the API (`apps/api-deploy`) redeploys on merge to `main`.
- Branch `fix/rounds-reconcile-cron` off `origin/main` (0a5b9cc), apply the 6-file
  change, push, PR into `main`, CI, merge → deploy.
- NOT touching: `feat/wave2-staff-content`, any env vars, the running bridge loop
  (kept until the cron is confirmed live in prod, then stopped).
- Rollback: revert the PR (the cron is additive; removing it restores prior behavior).
