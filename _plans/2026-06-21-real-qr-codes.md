# Real QR codes on punch cards

**Date:** 2026-06-21
**Status:** in progress
**Owner:** Yoav

## Problem

Cashier reports "barcode scanning is not working — only manually entering
the serial number works." Investigation confirms the scanner itself
(`@yudiel/react-qr-scanner` in [PosApp.tsx:2052](../apps/staff/src/pos/PosApp.tsx#L2052))
is wired correctly. The actual defect: every card UI in the app renders
`FauxQr` from `@memesh/brand` — a hash-derived decorative pixel pattern
that is **not a real QR symbol** and cannot be decoded by any scanner.

The component's own comment ([brand.tsx:168](../packages/brand/src/brand.tsx#L168))
flags this: "*The production build renders the real HMAC token via a QR
library; this is for the mock UI only.*" That wiring was never done before
the staff app went live with customers.

## Goals

- Customer-area card displays a real, scannable QR encoding the
  server-minted `qrToken`.
- Staff app's card view and post-sale confirmation also render the real QR
  (consistent UX; useful when a cashier hands the device to the customer).
- Existing manual-serial fallback continues to work unchanged.
- No API change required — `PunchCard.qrToken` is already returned to all
  three clients.

## Non-goals

- Printable / downloadable card PDF (next phase).
- Re-encoding existing cards — the token is mint-time, already in the DB.
- Replacing the `@yudiel/react-qr-scanner` reader; it's fine.

## Chosen approach: `qrcode.react@^4.2.0`

`QRCodeSVG` component, SVG-rendered, React 19 compatible. Wrapped in a new
`<MemeshQr value size />` exported from `@memesh/brand` so the three call
sites stay one-liners and future styling (brand colors, center mark,
margin) lands in one place.

### Settings

- `value`: `card.qrToken` (the HMAC token, ~200 chars base64url).
- `level`: `'M'` — 15% error correction. Scanner reads from a phone screen
  at arm's length; level L is too brittle if the screen has any glare,
  level Q/H bloats the symbol and pushes module size below 2 px at the
  customer card's display size.
- `marginSize`: `4` (per QR spec; required for reliable detection).
- `size`: 180 px on customer card (up from FauxQr's 130), 200 px on staff
  card view. Real symbol at ~v10 needs more area than the faux 21x21 grid.
- `bgColor`: `#FFFFFF`, `fgColor`: `INK` from brand tokens — matches the
  existing card surface.

### Alternatives rejected

- **`react-qr-code`** (smaller, SVG-only). Adequate for today's three call
  sites; rejected because the near-future printable/downloadable card needs
  Canvas-mode PNG export, which qrcode.react provides via `QRCodeCanvas`.
  One library covers both phases.
- **Direct `qrcode` (vanilla, draw to canvas yourself)**. More control, more
  code. Not justified for three small call sites today.

## Security

- Token is HMAC-signed server-side ([packages/qr-engine/src/token.ts](../packages/qr-engine/src/token.ts#L52)).
  Rendering it as a QR does not weaken the signature — anyone who could
  read the token from the customer's screen could already screenshot the
  serial number, and the server is the source of truth on punch validity.
- The customer's `/me` endpoint already returns `qrToken` over an
  authenticated session; this change does not widen the data exposure.
- The scanner endpoint (`/scan/lookup`, `/punch/by-token`) already verifies
  the HMAC and key id before touching the card. No new attack surface.
- No new third-party network call: `qrcode.react` renders client-side, no
  data leaves the device.

## Observability

- `console.info('[customer card] qr rendered', { serial, tokenLen })` on
  the customer card list — confirms the real token reached the render.
- `console.info('[pos card] qr rendered', { serial, tokenLen, ctx })` on
  both staff call sites (ctx = `'active-card' | 'post-sale'`).
- Token value itself is **not** logged — only its length, so the console
  is debuggable without leaking auth material.

## Testing

- New unit test in `packages/brand/src/brand.test.tsx`: render `<MemeshQr
  value="v1.abc.def" size={180} />` and assert the SVG root, the title
  attribute (a11y), and that the value is encoded (presence of `<path>`
  with non-empty `d`).
- Staff-app smoke: existing `App-isolation.test.ts` continues to pass.
- Manual: open customer area, confirm a QR with finder patterns and clear
  modules. Open staff app, scan customer's screen — should populate the
  preview modal end-to-end without manual serial entry.

## Settings audit

No new user-facing toggle needed — QR rendering is mandatory for the
flow to work. Future setting candidate (out of scope for this fix): "card
appearance" → brand color overrides for the QR foreground, useful if the
shop ever brands cards per holiday/event.

## Cost implications

None. `qrcode.react` is MIT-licensed, no runtime/network cost, no
subscription. Bundle adds ~5 kB gzipped to customer and staff apps.

## Open questions

None blocking.
