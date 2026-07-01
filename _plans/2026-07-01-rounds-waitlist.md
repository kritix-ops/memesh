# Rounds waitlist (רשימת המתנה)

Date: 2026-07-01
Spec: super-brief §8.

## Goal
When a round is full, a customer can join a FIFO waitlist. When a seat frees (cancel, swap-out, or hold expiry), the next-in-line is offered the seat with a claim window (default 60 min). If they don't claim in time, the offer expires and the next person is offered. Notifications (SMS + email) alert the customer; quiet hours (default 08:00-22:00) defer the offer to the next active window.

## Split
- **PR12 (this): backend engine.** join / leave / list, promote (on_slot_freed), claim marking, timeout sweep, wiring into cancel / swap / hold-expiry, endpoints, tests. Promotion sets `notified` + `claim_expires_at` and surfaces in the personal area (`/rounds/waitlist/mine`).
- **PR13: delivery + UI.** SMS + email push on promotion; customer UI to join when a round is full and claim when offered.

Until PR13, a promoted customer sees the offer when they open the app. That is the stated interim limitation.

## Engine (`rounds-waitlist.ts`)
- `joinWaitlist({ roundInstanceId, customerId, requestedType, requestedCompanions? })` — only when the round is full; idempotent (one active entry per customer per round); returns entry + position.
- `leaveWaitlist(entryId, customerId)` — owner-gated; waiting/notified → cancelled.
- `listCustomerWaitlist(customerId)` — active entries (waiting/notified) with round info + claim_expires_at.
- `promoteWaitlist(roundInstanceId, now)` = on_slot_freed. In a transaction: confirm the round has room now (a concurrent booking may have re-taken it); take the FIFO `waiting` entry with FOR UPDATE SKIP LOCKED (so concurrent frees promote different people); active-hours check (venue tz). In hours → notified + claim_expires_at = now + claim_window, return the entry (contact info for the notifier). Quiet hours → leave waiting, return deferred (a later active-hours sweep promotes it).
- `markWaitlistClaimed(roundInstanceId, customerId, now)` — called from the booking paths (mint + punch): a waiting/notified entry for this customer+round becomes `claimed`.
- `expireWaitlistClaims(now)` — sweep: `notified` past `claim_expires_at` → `expired`; returns the affected round ids so the caller re-promotes each.

## Wiring
- `cancelBooking` and `swapBooking` return the freed round id; their routes call `promoteWaitlist` after the seat is released.
- The hold-sweep cron: after `expireHolds`, promote each freed round; also `expireWaitlistClaims` then re-promote each expired round.
- `mintBooking` and `bookRoundWithPunch` call `markWaitlistClaimed` so a fulfilled offer closes.

## Correctness
- Promotion is race-safe: FOR UPDATE SKIP LOCKED on the entry, and a re-count of room inside the transaction so we never offer a seat that no longer exists.
- Claim is non-exclusive per the spec (the offer is a head start via the normal hold flow), so no seat is locked for the claim window; the timeout sweep moves the offer on.

## Schema
- `round_settings`: add `active_hours_start` (default 8) and `active_hours_end` (default 22). Migration 0021. `claim_window_minutes` already exists.

## Admin (§8.5)
- active_hours_start, active_hours_end, claim_window_minutes are already/now on round_settings; the settings UI exposure is a small follow-up.

## Out of scope (PR13+)
- SMS/email push on promotion; join/claim UI; scheduled quiet-hours notification (interim: an active-hours sweep re-attempts).
