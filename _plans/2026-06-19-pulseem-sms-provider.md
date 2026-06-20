# Pulseem SMS provider

Yanai signed up for Pulseem (pulseem.co.il) for SMS, WhatsApp, and email/newsletter sends. This adds the SMS path as a new selectable provider in the existing `SmsProvider` seam. WhatsApp and newsletter are out of scope for Phase 1 and can ride on the same Pulseem account later (different endpoints, separate provider files).

## Goal

Replace the placeholder `console` SMS provider with a real one driven by Pulseem so customer-OTP login works end-to-end against real phones. Keep `console` as the default so dev stays free.

## Decision

Build `PulseemProvider` alongside the existing `Sms019Provider` and `ConsoleSmsProvider`, env-selected via `SMS_PROVIDER`. The 019 provider stays in the tree (it was DRAFT, never connected to a live 019 account); it's harmless code and removing it now would muddy the history of *why* we picked Pulseem.

Why not WhatsApp for OTP: WhatsApp Business Platform requires pre-approved message templates (Pulseem exposes `SubmitWhatsAppTemplate` for this; approval is async, days). SMS works today with zero approval gating. WhatsApp can come later as a quality-of-life upgrade once a template is registered.

## API surface used

Verified against `https://api.pulseem.com/swagger/v1/swagger.json` (real OpenAPI spec, not the JS-rendered UI):

- **Auth**: `X-Api-Key: <key>` header
- **Endpoint**: `POST /api/v1/SmsApi/SendSms`
- **Body**:
  ```json
  {
    "sendId": "<uuid>",
    "isAsync": false,
    "smsSendData": {
      "fromNumber": "MEMESH",
      "toNumberList": ["0545822079"],
      "textList": ["קוד הכניסה: 482719"]
    }
  }
  ```
- **Response**: HTTP 200 on success; HTTP 500 on server error. Response body shape isn't fully documented; the provider treats HTTP status as the source of truth and falls back to the generated `sendId` as the return id when the server response omits one.

The provider always sends a single-element `toNumberList`/`textList` per call (the `SmsProvider` contract is one message at a time). Pulseem's batch shape is left available in case we want to switch to bulk later.

## Files

- `packages/sms/src/pulseem-provider.ts` — new provider impl
- `packages/sms/src/pulseem-provider.test.ts` — 9 unit tests (no live HTTP)
- `packages/sms/src/index.ts` — re-export
- `packages/sms/package.json` — add the test file to the `test` script
- `apps/api/src/config.ts` — add `pulseem` to the `SMS_PROVIDER` enum + `PULSEEM_API_KEY` / `PULSEEM_FROM_NUMBER` / `PULSEEM_BASE_URL` env vars
- `apps/api/src/lib/sms.ts` — wire the `'pulseem'` branch
- `.env.example`, `apps/api/.env.example` — document the new env vars

## Env vars

To flip the live deploy from `console` to `pulseem`:

| Var | Value | Where |
|---|---|---|
| `SMS_PROVIDER` | `pulseem` | Vercel project env (Production) |
| `PULSEEM_API_KEY` | from Pulseem dashboard | Vercel project env (Production), gitignored locally |
| `PULSEEM_FROM_NUMBER` | sender id (e.g. `MEMESH`) | Vercel project env (Production) |
| `PULSEEM_BASE_URL` | optional override; defaults to `https://api.pulseem.com` | only if Pulseem assigns a region-specific host |

## What's needed from Yanai

1. The **API key** from the Pulseem dashboard. Treat as secret; pass directly into Vercel env, never into git.
2. The **sender id** (alphanumeric, e.g. `MEMESH`) that's registered on the Pulseem account. If Pulseem requires a numeric sender, paste that number instead.
3. Optional: any region-specific base URL Pulseem assigned. Default works otherwise.

## Cost

Pulseem is a paid service per message. Yanai already has the account so the spend is his. Israeli SMS pricing is typically ₪0.05–0.10 per message at small volume. OTP-only traffic at Phase 1 scale (a few hundred logins/month) is in the single-digit shekels per month range. Worth keeping an eye on the Pulseem dashboard balance until we see a few months of real traffic.

## Security

- API key never logged. The provider's `[sms:pulseem] sending` and `[sms:pulseem] sent` logs include masked phone + sendId + length, not the body, not the key.
- Phone numbers are masked in logs (`054***`) — full numbers stay in DB only.
- `X-Api-Key` is sent over HTTPS only (the default base URL is `https://`).

## Observability

- `[sms:pulseem] sending` (info) on every outbound — masked phone, body length, sendId
- `[sms:pulseem] sent` (info) on success — sendId, http status, returned id
- `[sms:pulseem] failed` (warn) on failure — sendId, http status (when present), error message

## Tests

9 unit tests in `pulseem-provider.test.ts`, all stub `fetch`:

- constructor rejects missing apiKey
- constructor rejects missing fromNumber
- send POSTs to documented endpoint with `X-Api-Key` (not Bearer)
- body shape: `sendId` + `isAsync: false` + `smsSendData` with parallel arrays
- phone normalization (Israeli `+972 52 …` → `052…`)
- falls back to generated sendId when server omits id
- HTTP 4xx surfaces server's `message` field
- HTTP 500 with empty body returns `http_500`
- invalid phone returns ok:false without making an HTTP call
- custom `baseUrl` override

No live HTTP, no real account hit. First live send confirms (or corrects) the response-shape assumptions; the provider parses defensively so unexpected shapes log but don't crash.

## What's NOT in this chunk

- WhatsApp provider (separate module, needs an approved template per Pulseem)
- Newsletter / bulk email (out of scope for the punch-card system)
- Dropping the 019 provider (deferred — harmless code, removal can come with the next cleanup pass)
- The actual flip from `console` → `pulseem` in Vercel env (blocked on Yanai providing the API key)
