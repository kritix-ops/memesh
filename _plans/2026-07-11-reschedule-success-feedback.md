# Reschedule: visible landing feedback

Date: 2026-07-11
Source: Yanay's WhatsApp video, 2026-07-10 23:50 — "נראה שעובד השינוי, אבל זה
פשוט קופץ למטה, אין שום פידבק ברור". After a swap the bookings list re-sorts
by date, so the card silently relocates (his test: 16.07 → 04.08 sent it to
the bottom) with nothing marking success or where it went.

## Approach (apps/customer/src/customer/CustomerApp.tsx)

- RoundBookingCard gains `onMoved`, fired only AFTER the awaited list reload,
  so the highlight targets the re-sorted list.
- BookingsScreen tracks `movedId` (auto-clears after 8s — long enough to
  read, short enough to never look like a status).
- CollapsibleBooking with `justMoved`: forces itself open, scrolls into view
  (smooth, centered), takes the green success tint (same palette as the
  waitlist "spot freed" card), and shows a ribbon above the QR:
  "המועד שונה בהצלחה! שימו לב — זה הברקוד החדש לכניסה." The QR note matters:
  the swap re-mints the barcode, so a screenshot of the old one is dead.

## Alternatives rejected

- Toast/snackbar: says "success" but not WHERE the booking went — the jump
  was the confusing part; the highlight must live on the landed card.
- Keeping the list order stable (moved card stays put): lies about the list's
  date order and breaks on next load.

## Observability

`[customer bookings] booking rescheduled { bookingId }` when the highlight is
set; existing `[customer reschedule]` swap logs unchanged.

## Settings

None — transient feedback, not behavior.

## Testing

Source contracts added to CustomerApp-reschedule.test.ts: the ribbon string
exists, the moved card scrolls into view, and onMoved fires only after the
awaited reload. Customer suite + typecheck green. No renderer harness in the
repo (standing convention), so the scroll/tint visuals are Yanay's manual QA.

## Deploy

Branch `feat/customer-reschedule-feedback` → PR into `main`; standard
pipeline. Rollback: revert the merge commit.
