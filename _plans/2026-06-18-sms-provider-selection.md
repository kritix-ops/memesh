# SMS provider selection + DRAFT 019 SMS provider

Date: 2026-06-18
Status: Approved and in build.
Parent plan: `_plans/2026-06-17-memesh-phase1-build-plan.md` §10 (SMS).
Predecessor: `_plans/2026-06-18-cards-list-wiring.md`

Lifts SMS from "stub-only" to "env-selectable provider, with a draft 019 implementation ready to verify against a real account". Console stays the default so dev stays unchanged.

---

## 1. Goals

- One env var (`SMS_PROVIDER`) picks the active provider at boot. Defaults to `console`.
- A new `Sms019Provider` class implements `SmsProvider` against the 019 SMS HTTP API. Marked DRAFT because the wire format is not yet verified against a live account (see §2.1 honesty note).
- Israeli phone normalizer (`normalizeIsraeliPhone`) used by the 019 provider to convert any stored format (`052-3456789`, `+972 52-345-6789`, `0523456789`) into the `05XXXXXXXX` form 019 expects.
- Tests stub `globalThis.fetch` and verify the exact request shape we send, so when Yanai's account is wired we can compare the canned shape against what 019 actually accepts.
- Existing OTP flow is untouched — it still calls `smsProvider.send(...)`; the provider it gets just changes based on env.

Success looks like: `SMS_PROVIDER=console` (default) → OTPs log to stdout as today. `SMS_PROVIDER=019` + `SMS_019_TOKEN` + `SMS_019_SOURCE` set → next OTP triggers a real POST against 019. First few attempts may need wire-format tweaks; the env-switch back to console is one line.

## 2. Locked decisions

### 2.1 DRAFT 019 implementation (verify before going live)

**Honest unknowns** I'm coding around:

- 019's docs page is JS-rendered and the actual JSON request example is not in the static HTML.
- Their docs say "creating tokens from username/password is no longer supported" → token-based auth. The exact transport (header vs body) for the token is _most likely_ `Authorization: Bearer <token>` based on the docs' navigation hints, but not seen verbatim.
- JSON body structure: the XML structure is documented (`<sms><source/><destinations><phone/></destinations><message/></sms>`). The JSON equivalent is offered but the page won't render its sample. I'm using the flat JSON shape that's the natural projection of that XML.

**What this means in practice**:

- The provider is built defensively: configurable endpoint URL (defaults to the test endpoint), configurable token + source, JSON body shaped per the documented XML.
- Tests verify the request shape we EMIT. When Yanai gets an account, the first live attempt either works or fails with a clear 019 error code; either way the iteration is small.
- Production switch to live SMS requires three explicit env vars — no accidental activation.
- Default `SMS_PROVIDER=console` so this is opt-in.

### 2.2 Configurable endpoint, default to 019's test mode

- `SMS_019_ENDPOINT` env, defaults to `https://019sms.co.il/api/test` (the sandbox).
- Flip to `https://019sms.co.il/api` when ready for production.
- Reason: a wrong field name on `/api/test` is a "rejected for validation" log line; the same wrong field on `/api` would be a real spend.

### 2.3 Phone normalization in the provider, not the OTP layer

The OTP code accepts the customer's stored phone (whatever format they entered). 019 wants `05XXXXXXXX`. Normalization is a provider-layer concern (each provider may want a different format) — keep it next to the provider that needs it. Console provider doesn't normalize (logs are clearer raw).

### 2.4 No retries in this chunk

If 019 returns 5xx or network blows up, we surface `{ ok: false, error: ... }` from `send()`. The OTP flow's caller already handles that gracefully (logs "[otp request] not sent" then returns success to the client so we don't reveal whether the phone is registered). Retries with backoff are a follow-up after the basic wire format is proven.

### 2.5 Logs mask the phone

`[sms:019] sent to=052*** id=<server-id>` rather than the full phone in logs. Phone is PII; we still log enough to correlate a sent message with an OTP record if needed.

## 3. Files this chunk produces or modifies

```
packages/sms/src/phone.ts                # new: normalizeIsraeliPhone
packages/sms/src/phone.test.ts           # new: 6 cases
packages/sms/src/019-provider.ts         # new: Sms019Provider class (DRAFT)
packages/sms/src/019-provider.test.ts    # new: fetch-stub tests for request shape + responses
packages/sms/src/index.ts                # export new pieces
packages/sms/package.json                # register new test files
apps/api/src/lib/sms.ts                  # env-driven factory: createSmsProvider(env)
apps/api/src/config.ts                   # add SMS_PROVIDER, SMS_019_* env vars
apps/api/.env.example                    # document
.env.example                             # document
docker-compose.yml                       # pass new env vars to the api container
```

No changes to the OTP flow itself or to the customer cookie shape.

## 4. Build sequence

1. `normalizeIsraeliPhone` + tests.
2. `Sms019Provider` + fetch-stub tests for request shape + success + error.
3. Env-driven factory in `apps/api/src/lib/sms.ts`.
4. Env-schema additions in `config.ts`.
5. .env examples + docker-compose.
6. Verify: typecheck, full test sweep, build, format.

## 5. Security (rule 13)

- `SMS_019_TOKEN` is a secret, treated identically to other secrets — env-only, never logged, never returned from any API endpoint.
- Logs mask phones (first 3 digits visible).
- Test endpoint is the default. Production endpoint requires an explicit env flip.
- The factory throws at boot if `SMS_PROVIDER=019` is set without `SMS_019_TOKEN` + `SMS_019_SOURCE`. Fail-loud beats sending into the void.
- No retries means no accidental amplification on transient errors. A real production retry mechanism comes with rate-limit awareness later.

## 6. Observability (rule 14)

- `[sms:019] sending` with `{ to: masked, length }` before the POST.
- `[sms:019] sent` with `{ to: masked, status: <http>, id: <provider-id> }` on success.
- `[sms:019] failed` with `{ to: masked, status, error }` on any failure.
- Existing `[otp request] not sent` log on the caller side is unchanged.

## 7. Testing (rule 18)

- `phone.test.ts`: `052-3456789` → `0523456789`; `+972 52 345 6789` → `0523456789`; `+972523456789` → `0523456789`; `0523456789` → `0523456789`; spaces / dashes / parens all stripped; non-Israeli numbers pass through unchanged (we do not invent country logic we cannot verify); empty / null inputs throw.
- `019-provider.test.ts`: stub fetch; verify (a) POST to the configured endpoint, (b) `Authorization: Bearer <token>` header, (c) `Content-Type: application/json` header, (d) body shape matches `{ source, destinations: { phone: '0523...' }, message }`, (e) success path returns `{ ok: true, id }`, (f) error path returns `{ ok: false, error }`, (g) phone is normalized before sending.
- Existing api/db/auth tests unchanged.
- Expect ~118 tests total after this chunk (was 114).

## 8. Settings (rule 15)

- No new user-facing settings. SMS provider is an operator concern living in env.
- Future: an admin settings page could surface the active provider + a "send test SMS" button for ops. Not now.

## 9. Yanai blockers

To actually send a real SMS, we need from Yanai:

- A 019 account.
- An API token generated in their dashboard (Settings → API Token Management → Create New Token).
- A registered sender ID (`MEMESH` likely, up to 11 chars, Latin + digits only per docs).
- A funded balance.

Until those land, the code is built but the runtime stays on the console provider.

## 10. Out of scope (deferred)

- Real SMS send retries with backoff.
- Delivery-receipt webhooks from 019 back into our DB.
- A second provider (Twilio fallback, or local-then-international).
- Outbound throttling beyond what 019 enforces.
- Admin "send test" button.
- Marketing campaign sends (different rate-limit envelope).

## 11. Alternatives rejected

- **Wait for Yanai's account before writing any 019 code.** Lower risk but slower. The scaffolding stays useful regardless of whether the final provider is 019, Twilio, or something else.
- **Build a "generic HTTP" provider configured entirely from env.** Tempting but overengineered for a one-provider future; specific class is clearer.
- **Use the deprecated username/password auth from the old Go client.** Docs explicitly say it's no longer supported. Rejected.

## 12. Open questions

- Exact JSON field name for the API token in the body, if it's not the Bearer header. (Coding the Bearer-header path; will adjust if 019 rejects.)
- The shape of `destinations` in JSON: a single object vs an array. Coding as a single object for one recipient; arrays for batch is a future enhancement.
- Whether 019 wants `Content-Type: application/json` explicitly or auto-detects.
