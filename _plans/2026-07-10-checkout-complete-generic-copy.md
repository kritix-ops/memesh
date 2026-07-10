# Checkout-complete page: purchase-agnostic copy

Date: 2026-07-10
Source: Yanay's WhatsApp, 2026-07-09 21:56 — buying a single ticket lands on
"הכרטיסייה שלך מוכנה ומחכה לך באזור האישי", which reads wrong for a ticket.
His suggestion: say "ההזמנה שלך" so one wording fits every purchase.

## Scope

Two halves, only one needs code:

1. **Admin-editable (no code)**: the ready-card title/body render from
   card_settings — Yanay changes them today in admin → Settings → דף תודה,
   e.g. "ההזמנה שלך מוכנה ומחכה לך באזור האישי. נשמח לראותך אצלנו בקרוב."
2. **Code**: the two hardcoded strings in CheckoutComplete.tsx said
   "כרטיסייה" — the loading subtitle and the failed-link body. Both now say
   "ההזמנה שלך".

Deliberately NOT changing the card_settings DB column default: production
already holds a row (defaults never re-apply), and a migration for wording
alone is risk without benefit. Fresh environments inherit the old default;
acceptable, and the admin screen fixes it in seconds.

## Testing

Source-structure guard (repo convention, no React renderer):
CheckoutComplete-copy.test.ts asserts no hardcoded "כרטיסייה" remains in the
component code (comments stripped) and pins the two generic strings. Customer
suite: 5/5 pass.

## Deploy

Branch `fix/checkout-complete-copy` → PR into `main`; standard pipeline.
Remind Yanay to also edit the ready-card text in admin → Settings → דף תודה —
that half ships itself.
